import {
  ExamArchiveState,
  ExamMeta,
  ParsedExamBundle,
  SUBJECT_LIST,
  SubjectKey,
  StudentExamRecord,
  StudentProfile,
} from '../types/exam';
import { buildStudentKey, examRosterKey, normalizeClassName, normalizeTurkish } from './examLabels';
import { isAttendedExamRecord } from './analytics';

const STORAGE_KEY = 'lgs_deneme_arsivi_v1';

export const EMPTY_ARCHIVE_STATE: ExamArchiveState = {
  exams: [],
  students: [],
};

/**
 * Simple Levenshtein edit distance to handle minor Turkish glyph drops across publishers
 * (e.g. "ALI AVCIO LU" vs "ALI AVCIOGLU").
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }
  return dp[b.length];
}

function buildNameSignature(name: string): string {
  return normalizeTurkish(name).replace(/\s+/g, '');
}

function buildSortedTokensSignature(name: string): string {
  return normalizeTurkish(name).split(/\s+/).filter(Boolean).sort().join(' ');
}

function cleanStudentNo(numara: string | undefined): string {
  return (numara || '').replace(/\D/g, '').replace(/^0+/, '');
}

function findStudentMatch(
  students: Iterable<StudentProfile>,
  incoming: Pick<StudentProfile, 'numara' | 'name' | 'sinif'>,
  incomingExams: readonly StudentExamRecord[],
): StudentProfile | undefined {
  const key = examRosterKey(incoming.numara, incoming.name, incoming.sinif);
  const name = buildNameSignature(incoming.name);
  const sortedName = buildSortedTokensSignature(incoming.name);
  const number = cleanStudentNo(incoming.numara);
  const classroom = normalizeClassName(incoming.sinif || '');
  const incomingById = new Map(incomingExams.map((record) => [record.examId, record]));
  let best: StudentProfile | undefined;
  let bestScore = 0;
  let ambiguous = false;

  for (const student of students) {
    const sameIdentity = examRosterKey(student.numara, student.name, student.sinif) === key;
    // A conflicting source rank separates two rows without numbered identities in the same exam.
    const sharedExams = student.exams.filter((exam) => incomingById.has(exam.examId));
    if (sharedExams.length && (!sameIdentity || (!number && sharedExams.some((exam) => {
      const previousRank = exam.dereceler?.okul;
      const incomingRank = incomingById.get(exam.examId)?.dereceler?.okul;
      return previousRank && incomingRank && previousRank !== incomingRank;
    })))) continue;
    const knownNumber = cleanStudentNo(student.numara);
    if (number && knownNumber && number !== knownNumber) continue;
    const sameNumber = Boolean(number && number === knownNumber);
    const sameClass = classroom === normalizeClassName(student.sinif);
    if (!sameClass && !sameNumber) continue;
    const candidateName = buildNameSignature(student.name);
    let score = 0;
    if (sameIdentity) {
      score = sharedExams.length ? 5 : 4;
    } else if (name === candidateName || sortedName === buildSortedTokensSignature(student.name)) {
      score = sameClass ? 3 : 2;
    } else if (sameClass && sameNumber && name.length >= 6 && editDistance(name, candidateName) <= 2) {
      score = 1;
    }
    if (score > bestScore) {
      best = student;
      bestScore = score;
      ambiguous = false;
    } else if (score > 0 && score === bestScore) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : best;
}

function scoreNameQuality(name: string): number {
  let score = name.trim().length;
  // Prefer properly accented Turkish characters over stripped ASCII
  const trChars = (name.match(/[ÇĞİÖŞÜçğıöşü]/g) || []).length;
  score += trChars * 3;
  // Penalize broken double spaces
  if (/\s{2,}/.test(name)) score -= 6;
  return score;
}

function pickBetterName(a: string, b: string): string {
  return scoreNameQuality(b) > scoreNameQuality(a) ? b.trim() : a.trim();
}

function pickBetterClass(a: string, b: string): string {
  const ca = normalizeClassName(a || '');
  const cb = normalizeClassName(b || '');
  const aUnknown = !ca || ca.endsWith('-XX') || ca === 'XX';
  const bUnknown = !cb || cb.endsWith('-XX') || cb === 'XX';
  if (aUnknown && !bUnknown) return cb;
  if (!aUnknown) return ca;
  return cb || '8-A';
}

function mergeStudentExamRecords(
  existingExams: StudentExamRecord[],
  incomingExams: StudentExamRecord[],
  validExamIds?: Set<string>
): StudentExamRecord[] {
  const byExamId = new Map<string, StudentExamRecord>();

  const addRecord = (rec: StudentExamRecord) => {
    // Ignore absent / "Girmedi" placeholder rows (0 score, 0 correct, 0 wrong, 0 net)
    if (!isAttendedExamRecord(rec)) return;
    if (validExamIds && validExamIds.size > 0 && !validExamIds.has(rec.examId)) return;
    const prev = byExamId.get(rec.examId);
    if (!prev) {
      byExamId.set(rec.examId, rec);
    } else {
      const prevRichness =
        (prev.kazanimlar?.length ?? 0) * 10 +
        (prev.dereceler?.okul ? 3 : 0) +
        (prev.dereceler?.genel ? 2 : 0) +
        (prev.lgsPuan > 0 ? 5 : 0);
      const recRichness =
        (rec.kazanimlar?.length ?? 0) * 10 +
        (rec.dereceler?.okul ? 3 : 0) +
        (rec.dereceler?.genel ? 2 : 0) +
        (rec.lgsPuan > 0 ? 5 : 0);

      const winner = recRichness >= prevRichness ? rec : prev;
      const loser = recRichness >= prevRichness ? prev : rec;
      byExamId.set(rec.examId, {
        ...winner,
        kazanimlar:
          winner.kazanimlar.length >= loser.kazanimlar.length
            ? winner.kazanimlar
            : loser.kazanimlar,
      });
    }
  };

  for (const ex of existingExams) addRecord(ex);
  for (const ex of incomingExams) addRecord(ex);

  return Array.from(byExamId.values()).sort((a, b) => {
    if (a.examOrder !== b.examOrder) return a.examOrder - b.examOrder;
    return a.examDate.localeCompare(b.examDate);
  });
}

/**
 * Heals and deduplicates an entire ExamArchiveState:
 * - Merges compatible StudentProfile entries while keeping distinct rows in the same exam
 * - Deduplicates each student's exam records
 * - Normalizes canonical Firestore-safe student IDs and recalculates exam participant counts
 */
export function deduplicateArchiveState(state: ExamArchiveState): {
  state: ExamArchiveState;
  removedDuplicates: number;
} {
  // 1. Deduplicate ExamMeta list by id
  const examMetaMap = new Map<string, ExamMeta>();
  for (const ex of state.exams) {
    if (!examMetaMap.has(ex.id)) {
      examMetaMap.set(ex.id, { ...ex });
    }
  }

  const validExamIds = new Set(examMetaMap.keys());

  // 2. Merge duplicate StudentProfiles
  const mergedList: StudentProfile[] = [];

  for (const rawStudent of state.students) {
    if (!rawStudent || !rawStudent.name) continue;
    const sinif = normalizeClassName(rawStudent.sinif || '8-A');
    const no = cleanStudentNo(rawStudent.numara);
    const target = findStudentMatch(mergedList, rawStudent, rawStudent.exams || []);

    if (target) {
      const matchIdx = mergedList.indexOf(target);
      const mergedNo = cleanStudentNo(target.numara) || no || '0';
      const mergedName = pickBetterName(target.name, rawStudent.name);
      const mergedSinif = pickBetterClass(target.sinif, sinif);
      const mergedExams = mergeStudentExamRecords(target.exams, rawStudent.exams || [], validExamIds);

      mergedList[matchIdx] = {
        ...target,
        numara: mergedNo,
        name: mergedName,
        sinif: mergedSinif,
        exams: mergedExams,
      };

    } else {
      const canonicalId = buildStudentKey(no || '0', rawStudent.name, sinif);
      const cleanProfile: StudentProfile = {
        id: canonicalId,
        numara: no || '0',
        name: rawStudent.name.replace(/\s+/g, ' ').trim(),
        sinif,
        exams: mergeStudentExamRecords([], rawStudent.exams || [], validExamIds),
      };
      mergedList.push(cleanProfile);
    }
  }

  // Ensure every student has a unique Firestore-safe ID
  const usedIds = new Set<string>();
  const finalStudents = mergedList
    .filter((s) => s.exams.length > 0)
    .map((s) => {
      let id = buildStudentKey(s.numara, s.name, s.sinif);
      if (usedIds.has(id)) {
        const sig = buildNameSignature(s.name).slice(0, 8);
        id = `${id}_${sig}`;
        let counter = 2;
        while (usedIds.has(id)) {
          id = `${id}_${counter++}`;
        }
      }
      usedIds.add(id);
      return { ...s, id };
    });

  const removedDuplicates = Math.max(0, state.students.length - finalStudents.length);

  // 3. Recompute accurate participant counts & school averages per exam so all charts/rankings stay synced
  const examRecordsMap = new Map<string, StudentExamRecord[]>();
  for (const st of finalStudents) {
    for (const ex of st.exams) {
      const arr = examRecordsMap.get(ex.examId);
      if (arr) {
        arr.push(ex);
      } else {
        examRecordsMap.set(ex.examId, [ex]);
      }
    }
  }

  const finalExams = Array.from(examMetaMap.values())
    .map((ex) => {
      const recs = examRecordsMap.get(ex.id) ?? [];
      if (recs.length === 0) {
        return { ...ex, studentCount: 0 };
      }
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const avgLgs = round2(recs.reduce((acc, r) => acc + r.lgsPuan, 0) / recs.length);
      const avgNet = round2(recs.reduce((acc, r) => acc + r.toplam.net, 0) / recs.length);
      const subjectNets: Partial<Record<SubjectKey, number>> = {};
      for (const s of SUBJECT_LIST) {
        subjectNets[s.key] = round2(
          recs.reduce((acc, r) => acc + (r.subjects[s.key]?.net ?? 0), 0) / recs.length
        );
      }
      return {
        ...ex,
        studentCount: recs.length,
        schoolAvgLgs: removedDuplicates > 0 || ex.schoolAvgLgs === undefined ? avgLgs : ex.schoolAvgLgs,
        schoolAvgToplamNet:
          removedDuplicates > 0 || ex.schoolAvgToplamNet === undefined ? avgNet : ex.schoolAvgToplamNet,
        schoolSubjectNets:
          removedDuplicates > 0 || !ex.schoolSubjectNets ? subjectNets : ex.schoolSubjectNets,
      };
    })
    .sort((a, b) => a.examOrder - b.examOrder);

  return {
    state: {
      exams: finalExams,
      students: finalStudents,
    },
    removedDuplicates,
  };
}

export function loadArchiveState(): ExamArchiveState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExamArchiveState;
    if (!parsed || !Array.isArray(parsed.exams) || !Array.isArray(parsed.students)) {
      return null;
    }
    const bundledSamples = parsed.exams.filter(
      (exam) => exam.isSample && exam.fileName === 'zekiayvenli-8sınıf-işleyenzeka-1denme-toplu.pdf'
    );
    const archive = bundledSamples.reduce(
      (state, exam) => deleteExamFromState(state, exam.id),
      parsed
    );
    const { state: cleaned, removedDuplicates } = deduplicateArchiveState(archive);
    if (bundledSamples.length > 0 || removedDuplicates > 0) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      } catch {
        // ignore quota error
      }
    }
    return cleaned;
  } catch {
    return null;
  }
}

export function saveArchiveState(state: ExamArchiveState): { ok: boolean; error?: string } {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Tarayıcı depolama alanı doldu. JSON yedek indirip eski denemeleri temizleyebilirsiniz.',
    };
  }
}

export function clearArchiveState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function mergeExamBundle(
  prev: ExamArchiveState,
  bundle: ParsedExamBundle,
  retainedOrder?: number,
): { nextState: ExamArchiveState; matchedCount: number; newStudentsCount: number } {
  // Always start from a clean deduplicated baseline
  const baseline = deduplicateArchiveState(prev).state;
  const existingExams = [...baseline.exams];
  const nextOrder =
    existingExams.length > 0 ? Math.max(...existingExams.map((e) => e.examOrder)) + 1 : 1;

  const examMeta = {
    ...bundle.examMeta,
    examOrder: retainedOrder ?? nextOrder,
  };

  const studentMap = new Map<string, StudentProfile>();

  for (const s of baseline.students) {
    studentMap.set(s.id, {
      ...s,
      sinif: normalizeClassName(s.sinif),
      exams: [...s.exams],
    });
  }

  let matchedCount = 0;
  let newStudentsCount = 0;

  for (const item of bundle.records) {
    const cleanSinif = normalizeClassName(item.sinif);
    const updatedRecord: StudentExamRecord = {
      ...item.record,
      examId: examMeta.id,
      examName: examMeta.name,
      examOrder: examMeta.examOrder,
    };

    const existing = findStudentMatch(studentMap.values(), item, [updatedRecord]);
    if (existing) {
      matchedCount += 1;
      if ((!existing.numara || existing.numara === '0') && item.numara && item.numara !== '0') {
        existing.numara = item.numara;
      }
      existing.sinif = pickBetterClass(existing.sinif, cleanSinif);
      existing.name = pickBetterName(existing.name, item.name);
      existing.exams = existing.exams.filter((e) => e.examId !== examMeta.id);
      existing.exams.push(updatedRecord);
    } else {
      newStudentsCount += 1;
      let newId = buildStudentKey(item.numara, item.name, cleanSinif);
      if (studentMap.has(newId)) {
        const baseId = `${newId.slice(0, 110)}_${buildNameSignature(item.name).slice(0, 8)}`;
        newId = baseId;
        let suffix = 2;
        while (studentMap.has(newId)) newId = `${baseId}_${suffix++}`;
      }
      const newProfile: StudentProfile = {
        id: newId,
        numara: item.numara || '0',
        name: item.name.replace(/\s+/g, ' ').trim(),
        sinif: cleanSinif,
        exams: [updatedRecord],
      };
      studentMap.set(newProfile.id, newProfile);
    }
  }

  const rawNextState: ExamArchiveState = {
    exams: [...existingExams, examMeta],
    students: Array.from(studentMap.values()),
  };

  const { state: nextState } = deduplicateArchiveState(rawNextState);

  return { nextState, matchedCount, newStudentsCount };
}

export function replacePdfExamInState(prev: ExamArchiveState, examId: string, bundle: ParsedExamBundle) {
  const existing = prev.exams.find((exam) => exam.id === examId);
  if (!existing || !/\.pdf$/i.test(existing.fileName) || existing.isSample) {
    throw new Error('Yeniden okunacak PDF denemesi arşivde bulunamadı.');
  }
  const sourceName = (name: string) => name.normalize('NFC').toLocaleLowerCase('tr');
  if (sourceName(existing.fileName) !== sourceName(bundle.examMeta.fileName)) {
    throw new Error(`Bu deneme için arşivdeki PDF dosyasını seçin: ${existing.fileName}`);
  }
  if (!bundle.records.length || bundle.warnings?.length) {
    throw new Error(bundle.warnings?.join(' ') || 'PDF’de geçerli sonuç bulunamadı.');
  }

  return mergeExamBundle(deleteExamFromState(prev, examId), {
    ...bundle,
    examMeta: { ...bundle.examMeta, id: examId, name: existing.name },
  }, existing.examOrder);
}

export function deleteExamFromState(prev: ExamArchiveState, examId: string): ExamArchiveState {
  const exams = prev.exams.filter((e) => e.id !== examId);
  const students = prev.students
    .map((s) => ({
      ...s,
      exams: s.exams.filter((ex) => ex.examId !== examId),
    }))
    .filter((s) => s.exams.length > 0);
  return { exams, students };
}

export function renameExamInState(
  prev: ExamArchiveState,
  examId: string,
  newName: string
): ExamArchiveState {
  const trimmed = newName.trim();
  if (!trimmed) return prev;
  return {
    exams: prev.exams.map((e) => (e.id === examId ? { ...e, name: trimmed } : e)),
    students: prev.students.map((s) => ({
      ...s,
      exams: s.exams.map((ex) => (ex.examId === examId ? { ...ex, examName: trimmed } : ex)),
    })),
  };
}

export function addManualExamToStudent(
  prev: ExamArchiveState,
  studentId: string,
  newRecord: StudentExamRecord
): ExamArchiveState {
  const examExists = prev.exams.some((e) => e.id === newRecord.examId);
  const exams = examExists
    ? prev.exams
    : [
        ...prev.exams,
        {
          id: newRecord.examId,
          name: newRecord.examName,
          fileName: 'Manuel Giriş',
          schoolName: prev.exams[0]?.schoolName || '8. Sınıf LGS Okul Arşivi',
          location: prev.exams[0]?.location || '',
          examDate: newRecord.examDate,
          uploadedAt: newRecord.uploadedAt,
          examOrder: newRecord.examOrder,
          studentCount: 1,
          schoolAvgLgs: newRecord.lgsPuan,
          schoolAvgToplamNet: newRecord.toplam.net,
        },
      ];

  const students = prev.students.map((s) =>
    s.id === studentId ? { ...s, exams: [...s.exams, newRecord] } : s
  );
  return { exams, students };
}
