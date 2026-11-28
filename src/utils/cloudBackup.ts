import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  serverTimestamp,
  runTransaction,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  ExamArchiveState,
  ExamMeta,
  SUBJECT_LIST,
  SubjectKey,
  StudentExamRecord,
  StudentProfile,
} from '../types/exam';
import { deduplicateArchiveState } from './storage';

// Blueprint maxLength & volumetric constants (synchronized with firebase-blueprint.json & firestore.rules)
const MAX_ID_LEN = 128;
const MAX_DISPLAY_NAME_LEN = 120;
const MAX_EXAM_NAME_LEN = 200;
const MAX_FILE_NAME_LEN = 260;
const MAX_SCHOOL_NAME_LEN = 200;
const MAX_LOCATION_LEN = 200;
const MAX_EXAM_DATE_LEN = 40;
const MAX_UPLOADED_AT_LEN = 64;
const MAX_NUMARA_LEN = 40;
const MAX_STUDENT_NAME_LEN = 160;
const MAX_SINIF_LEN = 40;
const MAX_EXAMS_PER_STUDENT = 100;
const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_TRANSACTION_DOCS = 100;

function clampString(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val.trim() : fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function finiteNumber(val: unknown, min: number, max: number, fallback = 0): number {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.max(min, Math.min(max, n));
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Guarantees every Firestore document ID strictly matches ^[a-zA-Z0-9_\-]+$ and <= 128 chars.
 */
export function sanitizeFirestoreId(rawId: string, prefix = 'rec'): string {
  const cleaned = (rawId || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (cleaned.length >= 1 && cleaned.length <= MAX_ID_LEN && VALID_ID_REGEX.test(cleaned)) {
    return cleaned;
  }

  const suffix = simpleHash(rawId || `${prefix}_${Date.now()}`);
  const base = cleaned.slice(0, MAX_ID_LEN - prefix.length - suffix.length - 2);
  const candidate = base ? `${prefix}_${base}_${suffix}` : `${prefix}_${suffix}`;
  return candidate.slice(0, MAX_ID_LEN);
}

/**
 * Recursively removes `undefined` properties and non-finite numbers so Firestore never rejects writes.
 */
function stripUndefinedDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') {
    return (Number.isFinite(value) ? value : 0) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

function sanitizeSubjectNetMap(
  raw?: Partial<Record<SubjectKey, number>>
): Partial<Record<SubjectKey, number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<SubjectKey, number>> = {};
  let hasAny = false;
  for (const s of SUBJECT_LIST) {
    const val = raw[s.key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[s.key] = Math.round(val * 100) / 100;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

function buildSanitizedExamFields(exam: ExamMeta): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    name: clampString(exam.name, MAX_EXAM_NAME_LEN, 'Deneme Sınavı') || 'Deneme Sınavı',
    fileName: clampString(exam.fileName, MAX_FILE_NAME_LEN, 'deneme.pdf') || 'deneme.pdf',
    schoolName: clampString(exam.schoolName, MAX_SCHOOL_NAME_LEN, ''),
    location: clampString(exam.location, MAX_LOCATION_LEN, ''),
    examDate: clampString(exam.examDate, MAX_EXAM_DATE_LEN, ''),
    uploadedAt: clampString(exam.uploadedAt, MAX_UPLOADED_AT_LEN, new Date().toISOString()),
    examOrder: finiteNumber(exam.examOrder, 0, 10000, 1),
    studentCount: Math.round(finiteNumber(exam.studentCount, 0, 5000, 0)),
  };

  if (typeof exam.isSample === 'boolean') {
    fields.isSample = exam.isSample;
  }
  if (typeof exam.schoolAvgLgs === 'number' && Number.isFinite(exam.schoolAvgLgs)) {
    fields.schoolAvgLgs = finiteNumber(exam.schoolAvgLgs, 0, 600);
  }
  if (typeof exam.generalAvgLgs === 'number' && Number.isFinite(exam.generalAvgLgs)) {
    fields.generalAvgLgs = finiteNumber(exam.generalAvgLgs, 0, 600);
  }
  if (typeof exam.schoolAvgToplamNet === 'number' && Number.isFinite(exam.schoolAvgToplamNet)) {
    fields.schoolAvgToplamNet = finiteNumber(exam.schoolAvgToplamNet, -30, 90);
  }
  if (typeof exam.generalAvgToplamNet === 'number' && Number.isFinite(exam.generalAvgToplamNet)) {
    fields.generalAvgToplamNet = finiteNumber(exam.generalAvgToplamNet, -30, 90);
  }

  const schoolNets = sanitizeSubjectNetMap(exam.schoolSubjectNets);
  if (schoolNets) fields.schoolSubjectNets = schoolNets;

  const generalNets = sanitizeSubjectNetMap(exam.generalSubjectNets);
  if (generalNets) fields.generalSubjectNets = generalNets;

  return fields;
}

function sanitizeStudentExamRecord(
  rec: StudentExamRecord,
  examIdMap: Map<string, string>
): StudentExamRecord {
  const mappedExamId = examIdMap.get(rec.examId) ?? sanitizeFirestoreId(rec.examId, 'exam');
  return stripUndefinedDeep({
    ...rec,
    examId: mappedExamId,
    examName: clampString(rec.examName, MAX_EXAM_NAME_LEN, 'Deneme Sınavı') || 'Deneme Sınavı',
    examDate: clampString(rec.examDate, MAX_EXAM_DATE_LEN, ''),
    uploadedAt: clampString(rec.uploadedAt, MAX_UPLOADED_AT_LEN, ''),
    examOrder: finiteNumber(rec.examOrder, 0, 10000, 1),
    lgsPuan: finiteNumber(rec.lgsPuan, 0, 600, 0),
    kazanimlar: Array.isArray(rec.kazanimlar) ? rec.kazanimlar.slice(0, 120) : [],
  });
}

function buildSanitizedStudentFields(
  student: StudentProfile,
  examIdMap: Map<string, string>
): Record<string, unknown> {
  const safeExams = (student.exams || [])
    .map((ex) => sanitizeStudentExamRecord(ex, examIdMap));

  return {
    numara: clampString(student.numara, MAX_NUMARA_LEN, '0'),
    name: clampString(student.name, MAX_STUDENT_NAME_LEN, 'Öğrenci') || 'Öğrenci',
    sinif: clampString(student.sinif, MAX_SINIF_LEN, '8-A') || '8-A',
    exams: safeExams,
  };
}

export interface CloudLoadResult {
  exists: boolean;
  archive: ExamArchiveState;
  lastBackupAt: Date | null;
}

export async function loadArchiveFromCloud(uid: string): Promise<CloudLoadResult> {
  const safeUid = sanitizeFirestoreId(uid, 'u');
  const rootPath = `users/${safeUid}`;
  const examsPath = `users/${safeUid}/exams`;
  const studentsPath = `users/${safeUid}/students`;

  let lastBackupAt: Date | null = null;

  try {
    const rootSnap = await getDocFromServer(doc(db, 'users', safeUid));
    if (!rootSnap.exists()) {
      return {
        exists: false,
        archive: { exams: [], students: [] },
        lastBackupAt: null,
      };
    }

    const rootData = rootSnap.data();
    if (rootData?.lastBackupAt instanceof Timestamp) {
      lastBackupAt = rootData.lastBackupAt.toDate();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, rootPath);
  }

  const exams: ExamMeta[] = [];
  const students: StudentProfile[] = [];

  try {
    const examsQuery = query(
      collection(db, 'users', safeUid, 'exams'),
      where('ownerId', '==', safeUid)
    );
    const examsSnap = await getDocsFromServer(examsQuery);
    for (const d of examsSnap.docs) {
      const data = d.data();
      const exam: ExamMeta = {
        id: String(data.id || d.id),
        name: String(data.name || 'Deneme Sınavı'),
        fileName: String(data.fileName || 'deneme.pdf'),
        schoolName: String(data.schoolName || ''),
        location: String(data.location || ''),
        examDate: String(data.examDate || ''),
        uploadedAt: String(data.uploadedAt || ''),
        examOrder: Number(data.examOrder || 1),
        studentCount: Number(data.studentCount || 0),
        ...(typeof data.isSample === 'boolean' ? { isSample: data.isSample } : {}),
        ...(typeof data.schoolAvgLgs === 'number' ? { schoolAvgLgs: data.schoolAvgLgs } : {}),
        ...(typeof data.generalAvgLgs === 'number' ? { generalAvgLgs: data.generalAvgLgs } : {}),
        ...(typeof data.schoolAvgToplamNet === 'number'
          ? { schoolAvgToplamNet: data.schoolAvgToplamNet }
          : {}),
        ...(typeof data.generalAvgToplamNet === 'number'
          ? { generalAvgToplamNet: data.generalAvgToplamNet }
          : {}),
        ...(data.schoolSubjectNets ? { schoolSubjectNets: data.schoolSubjectNets } : {}),
        ...(data.generalSubjectNets ? { generalSubjectNets: data.generalSubjectNets } : {}),
      };
      exams.push(exam);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, examsPath);
  }

  try {
    const studentsQuery = query(
      collection(db, 'users', safeUid, 'students'),
      where('ownerId', '==', safeUid)
    );
    const studentsSnap = await getDocsFromServer(studentsQuery);

    for (const d of studentsSnap.docs) {
      const data = d.data();
      const student: StudentProfile = {
        id: String(data.id || d.id),
        numara: String(data.numara || '0'),
        name: String(data.name || 'Öğrenci'),
        sinif: String(data.sinif || '8-A'),
        exams: Array.isArray(data.exams) ? (data.exams as StudentExamRecord[]) : [],
      };
      students.push(student);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, studentsPath);
  }

  exams.sort((a, b) => a.examOrder - b.examOrder);

  const { state: cleanedCloud } = deduplicateArchiveState({ exams, students });

  return {
    exists: true,
    archive: cleanedCloud,
    lastBackupAt,
  };
}


/**
 * Explicit full snapshot backup. No automatic callers.
 * Upserts current exams/students, removes deleted cloud entries only after
 * all current documents are written, and updates the backup timestamp last.
 */
export async function backupFullArchiveToCloud(
  uid: string,
  displayName: string,
  archive: ExamArchiveState
): Promise<Date> {
  const safeUid = sanitizeFirestoreId(uid, 'u');
  if (safeUid !== uid) throw new Error('Geçersiz kullanıcı kimliği.');
  const rootRef = doc(db, 'users', safeUid);
  const exams = archive.exams.filter(exam => !exam.isSample);
  const examIds = new Map(exams.map(exam => [exam.id, sanitizeFirestoreId(exam.id, 'exam')]));
  const students = archive.students.map(student => ({
    ...student,
    exams: student.exams.filter(exam => examIds.has(exam.examId)),
  })).filter(student => student.exams.length > 0);
  if (exams.length === 0) {
    throw new Error('Boş arşiv buluttaki yedeği silemez. Önce gerçek bir deneme yükleyin.');
  }
  if (exams.length > 500 || students.length > 5000) {
    throw new Error('Bulut arşiv sınırı aşıldı.');
  }
  if (students.some(student => student.exams.length > MAX_EXAMS_PER_STUDENT)) {
    throw new Error('Bir öğrenci en fazla 100 deneme içerebilir.');
  }
  const examKeys = exams.map(exam => examIds.get(exam.id)!);
  const studentKeys = students.map(student => sanitizeFirestoreId(student.id, 'stu'));
  if (new Set(examKeys).size !== examKeys.length ||
      new Set(studentKeys).size !== studentKeys.length) {
    throw new Error('Bulut belge kimlikleri çakışıyor. Yedekleme iptal edildi.');
  }
  const safeDisplayName = clampString(displayName, MAX_DISPLAY_NAME_LEN, 'Öğretmen');
  try {
    await runTransaction(db, async transaction => {
      const root = await transaction.get(rootRef);
      if (!root.exists()) {
        transaction.set(rootRef, {
          ownerId: safeUid, displayName: safeDisplayName,
          examCount: 0, studentCount: 0,
          lastBackupAt: serverTimestamp(), createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    });
    const [existingExams, existingStudents] = await Promise.all([
      getDocsFromServer(query(collection(db, 'users', safeUid, 'exams'), where('ownerId', '==', safeUid))),
      getDocsFromServer(query(collection(db, 'users', safeUid, 'students'), where('ownerId', '==', safeUid))),
    ]);
    const oldExams = new Map(existingExams.docs.map(d => [d.id, d]));
    const oldStudents = new Map(existingStudents.docs.map(d => [d.id, d]));
    const operations: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
    for (const exam of exams) {
      const id = examIds.get(exam.id)!;
      const ref = doc(db, 'users', safeUid, 'exams', id);
      const old = oldExams.get(id);
      const fields = { ...buildSanitizedExamFields(exam), id, ownerId: safeUid,
        createdAt: old?.data().createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp() };
      operations.push(batch => batch.set(ref, fields));
    }
    for (let i = 0; i < students.length; i++) {
      const student = students[i];
      const id = studentKeys[i];
      const ref = doc(db, 'users', safeUid, 'students', id);
      const old = oldStudents.get(id);
      const fields = { ...buildSanitizedStudentFields(student, examIds),
        id, ownerId: safeUid,
        createdAt: old?.data().createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp() };
      operations.push(batch => batch.set(ref, fields));
    }
    // Write current records first. An interrupted backup never deletes old data.
    for (let i = 0; i < operations.length; i += 200) {
      const batch = writeBatch(db);
      operations.slice(i, i + 200).forEach(op => op(batch));
      await batch.commit();
    }
    const stale = [
      ...existingExams.docs.filter(d => !examKeys.includes(d.id)),
      ...existingStudents.docs.filter(d => !studentKeys.includes(d.id)),
    ];
    for (let i = 0; i < stale.length; i += 200) {
      const batch = writeBatch(db);
      stale.slice(i, i + 200).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await runTransaction(db, async transaction => {
      const root = await transaction.get(rootRef);
      if (!root.exists()) throw new Error('Bulut arşiv kökü bulunamadı.');
      transaction.update(rootRef, {
        displayName: safeDisplayName, examCount: exams.length,
        studentCount: students.length,
        lastBackupAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    });
    return new Date();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, rootRef.path);
    throw error;
  }
}

/** Append newly added exams and results while preserving every existing cloud record. */
export async function appendExamsToCloud(
  uid: string,
  displayName: string,
  archive: ExamArchiveState,
  examIds: ReadonlySet<string>
): Promise<Date | null> {
  const safeUid = sanitizeFirestoreId(uid, 'u');
  const rootRef = doc(db, 'users', safeUid);
  const exams = archive.exams.filter((exam) => examIds.has(exam.id) && !exam.isSample);
  if (exams.length === 0) return null;

  const examIdMap = new Map(exams.map((exam) => [exam.id, sanitizeFirestoreId(exam.id, 'exam')]));
  const additions = [
    ...exams.map((exam) => ({
      collection: 'exams' as const,
      id: examIdMap.get(exam.id)!,
      fields: buildSanitizedExamFields(exam),
    })),
    ...archive.students.flatMap((student) => {
      const records = student.exams.filter((record) => examIdMap.has(record.examId));
      if (records.length === 0) return [];
      return [{
        collection: 'students' as const,
        id: sanitizeFirestoreId(student.id, 'stu'),
        fields: buildSanitizedStudentFields({ ...student, exams: records }, examIdMap),
      }];
    }),
  ];

  const safeDisplayName = clampString(displayName, MAX_DISPLAY_NAME_LEN, 'Kullanıcı');
  try {
    // Existing rules require the parent to exist before any child write.
    await runTransaction(db, async (transaction) => {
      const root = await transaction.get(rootRef);
      if (!root.exists()) {
        transaction.set(rootRef, {
          ownerId: safeUid,
          displayName: safeDisplayName,
          examCount: 0,
          studentCount: 0,
          lastBackupAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    });

    let lastBackupAt: Date | null = null;
    for (let i = 0; i < additions.length; i += MAX_TRANSACTION_DOCS) {
      const chunk = additions.slice(i, i + MAX_TRANSACTION_DOCS);
      const wrote = await runTransaction(db, async (transaction) => {
        const root = await transaction.get(rootRef);
        const documents = await Promise.all(chunk.map(async (addition) => {
          const ref = doc(db, 'users', safeUid, addition.collection, addition.id);
          return { ...addition, ref, snapshot: await transaction.get(ref) };
        }));
        let examCount = Number(root.get('examCount') ?? 0);
        let studentCount = Number(root.get('studentCount') ?? 0);
        let changed = false;
        for (const { collection, id, fields, ref, snapshot } of documents) {
          const incoming = (fields.exams ?? []) as StudentExamRecord[];
          const stored = (snapshot.data()?.exams ?? []) as StudentExamRecord[];
          const knownExamIds = new Set(stored.map((record) => record.examId));
          const newRecords = incoming.filter((record) => {
            if (knownExamIds.has(record.examId)) return false;
            knownExamIds.add(record.examId);
            return true;
          });
          if (stored.length + newRecords.length > MAX_EXAMS_PER_STUDENT) {
            throw new Error('Bir öğrenci için bulut yedeği 100 deneme sınırına ulaştı.');
          }
          if (!snapshot.exists()) {
            transaction.set(ref, {
              ...fields,
              ...(collection === 'students' ? { exams: newRecords } : {}),
              id,
              ownerId: safeUid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            if (collection === 'exams') examCount += 1;
            else studentCount += 1;
            changed = true;
          } else if (newRecords.length > 0) {
            transaction.update(ref, {
              exams: [...stored, ...newRecords],
              updatedAt: serverTimestamp(),
            });
            changed = true;
          }
        }
        if (changed) {
          transaction.update(rootRef, {
            examCount: Math.min(500, examCount),
            studentCount: Math.min(5000, studentCount),
            lastBackupAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        return changed;
      });
      if (wrote) lastBackupAt = new Date();
    }
    return lastBackupAt;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, rootRef.path);
  }
}

/**
 * Smart non-destructive merge when signing in on a device that already has local exams.
 * Prevents overwriting newly uploaded local exams with older cloud state, and vice versa.
 */
export function mergeLocalAndCloudArchives(
  local: ExamArchiveState,
  cloud: ExamArchiveState,
  pendingExamIds: ReadonlySet<string> = new Set(),
): { merged: ExamArchiveState; localHadUniqueData: boolean } {
  if (cloud.exams.length === 0 && cloud.students.length === 0) {
    const { state: cleanedLocal } = deduplicateArchiveState(local);
    return {
      merged: cleanedLocal,
      localHadUniqueData: cleanedLocal.exams.length > 0 || cleanedLocal.students.length > 0,
    };
  }

  // If local only contains the bundled sample or is empty, prefer cloud directly
  const localHasOnlySample =
    local.exams.length === 0 || (local.exams.length === 1 && local.exams[0].isSample);
  if (localHasOnlySample) {
    const { state: cleanedCloud } = deduplicateArchiveState(cloud);
    return { merged: cleanedCloud, localHadUniqueData: false };
  }

  const examById = new Map<string, ExamMeta>();
  const examSignatureSet = new Set<string>();

  for (const ex of cloud.exams) {
    examById.set(ex.id, ex);
    examSignatureSet.add(`${ex.name.toLowerCase().trim()}__${ex.examDate}`);
  }

  let localHadUniqueData = false;
  const uniqueLocalExamIds = new Set<string>();
  const replacedExamIds = new Set<string>();
  let maxOrder = cloud.exams.reduce((m, e) => Math.max(m, e.examOrder), 0);

  for (const ex of local.exams) {
    const sig = `${ex.name.toLowerCase().trim()}__${ex.examDate}`;
    const remote = examById.get(ex.id);
    if (remote && pendingExamIds.has(ex.id)) {
      examById.set(ex.id, { ...ex, examOrder: remote.examOrder });
      uniqueLocalExamIds.add(ex.id);
      replacedExamIds.add(ex.id);
      localHadUniqueData = true;
    } else if (!remote && (!examSignatureSet.has(sig) || pendingExamIds.has(ex.id))) {
      maxOrder += 1;
      examById.set(ex.id, { ...ex, examOrder: maxOrder });
      examSignatureSet.add(sig);
      uniqueLocalExamIds.add(ex.id);
      localHadUniqueData = true;
    }
  }

  if (!localHadUniqueData) {
    return { merged: cloud, localHadUniqueData: false };
  }

  const studentById = new Map<string, StudentProfile>();
  for (const st of cloud.students) {
    studentById.set(st.id, { ...st, exams: st.exams.filter((record) => !replacedExamIds.has(record.examId)) });
  }

  for (const st of local.students) {
    const uniqueRecords = st.exams.filter((r) => uniqueLocalExamIds.has(r.examId));
    if (uniqueRecords.length === 0) continue;

    const existing = studentById.get(st.id);
    if (existing) {
      const existingExamIds = new Set(existing.exams.map((r) => r.examId));
      for (const rec of uniqueRecords) {
        if (!existingExamIds.has(rec.examId)) {
          const meta = examById.get(rec.examId);
          existing.exams.push({
            ...rec,
            examOrder: meta ? meta.examOrder : rec.examOrder,
          });
        }
      }
    } else {
      studentById.set(st.id, {
        ...st,
        exams: uniqueRecords.map((rec) => {
          const meta = examById.get(rec.examId);
          return { ...rec, examOrder: meta ? meta.examOrder : rec.examOrder };
        }),
      });
    }
  }

  const { state: dedupedMerged } = deduplicateArchiveState({
    exams: Array.from(examById.values()).sort((a, b) => a.examOrder - b.examOrder),
    students: Array.from(studentById.values()),
  });

  return {
    merged: dedupedMerged,
    localHadUniqueData: true,
  };
}
