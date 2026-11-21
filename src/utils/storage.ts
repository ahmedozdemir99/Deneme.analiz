import {
  ExamArchiveState,
  ExamMeta,
  ParsedExamBundle,
  SUBJECT_LIST,
  SubjectKey,
  StudentExamRecord,
  StudentProfile,
} from '../types/exam';
import { buildStudentKey, normalizeClassName, normalizeTurkish } from './pdfParser';
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
  const bySignature = new Map<string, string>();

  const addRecord = (rec: StudentExamRecord) => {
    // Ignore absent / "Girmedi" placeholder rows (0 score, 0 correct, 0 wrong, 0 net)
    if (!isAttendedExamRecord(rec)) return;
    if (validExamIds && validExamIds.size > 0 && !validExamIds.has(rec.examId)) return;
    const sig = `${normalizeTurkish(rec.examName)}__${rec.examDate}__${Math.round(rec.lgsPuan * 10)}__${Math.round(rec.toplam.net * 100)}`;
    const targetId = byExamId.has(rec.examId)
      ? rec.examId
      : bySignature.get(sig) ?? rec.examId;

    const prev = byExamId.get(targetId);
    if (!prev) {
      byExamId.set(rec.examId, rec);
      bySignature.set(sig, rec.examId);
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
      const canonicalExamId =
        validExamIds && !validExamIds.has(prev.examId) && validExamIds.has(rec.examId)
          ? rec.examId
          : prev.examId;

      if (canonicalExamId !== targetId) {
        byExamId.delete(targetId);
        bySignature.set(sig, canonicalExamId);
      }

      byExamId.set(canonicalExamId, {
        ...winner,
        examId: canonicalExamId,
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
 * - Merges duplicate StudentProfile entries (same name, reversed tokens, matching number, or minor Turkish glyph typos)
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
  const byExactName = new Map<string, number>();
  const bySortedTokens = new Map<string, number>();
  const byNo = new Map<string, number>();

  for (const rawStudent of state.students) {
    if (!rawStudent || !rawStudent.name) continue;
    const sinif = normalizeClassName(rawStudent.sinif || '8-A');
    const nameSig = buildNameSignature(rawStudent.name);
    const sortedTokens = buildSortedTokensSignature(rawStudent.name);
    const no = cleanStudentNo(rawStudent.numara);

    let matchIdx: number | undefined;

    // 2a. Exact normalized name match (catches "HALİL BALCI" vs "Halil Balcı" vs "HALIL  BALCI" regardless of ID/number drift)
    if (nameSig.length >= 3 && byExactName.has(nameSig)) {
      matchIdx = byExactName.get(nameSig);
    }

    // 2b. Reversed name token match ("BALCI HALİL" vs "HALİL BALCI")
    if (matchIdx === undefined && sortedTokens.length >= 3 && bySortedTokens.has(sortedTokens)) {
      matchIdx = bySortedTokens.get(sortedTokens);
    }

    // 2c. Same non-zero student number with compatible name
    if (matchIdx === undefined && no && byNo.has(no)) {
      const candidateIdx = byNo.get(no)!;
      const candidateSig = buildNameSignature(mergedList[candidateIdx].name);
      if (
        editDistance(candidateSig, nameSig) <= 3 ||
        (candidateSig.length >= 4 && candidateSig.slice(0, 4) === nameSig.slice(0, 4))
      ) {
        matchIdx = candidateIdx;
      }
    }

    // 2d. Fuzzy 1-2 character typo match (handles PDF font glyph drops like Ğ/Ş/İ)
    if (matchIdx === undefined && nameSig.length >= 6) {
      for (let i = 0; i < mergedList.length; i++) {
        const candidateSig = buildNameSignature(mergedList[i].name);
        if (editDistance(candidateSig, nameSig) <= 2) {
          matchIdx = i;
          break;
        }
      }
    }

    if (matchIdx !== undefined) {
      const target = mergedList[matchIdx];
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

      const updatedSig = buildNameSignature(mergedName);
      const updatedTokens = buildSortedTokensSignature(mergedName);
      if (updatedSig) byExactName.set(updatedSig, matchIdx);
      if (nameSig) byExactName.set(nameSig, matchIdx);
      if (updatedTokens) bySortedTokens.set(updatedTokens, matchIdx);
      if (sortedTokens) bySortedTokens.set(sortedTokens, matchIdx);
      if (mergedNo && mergedNo !== '0') byNo.set(mergedNo, matchIdx);
    } else {
      const idx = mergedList.length;
      const canonicalId = buildStudentKey(no || '0', rawStudent.name, sinif);
      const cleanProfile: StudentProfile = {
        id: canonicalId,
        numara: no || '0',
        name: rawStudent.name.replace(/\s+/g, ' ').trim(),
        sinif,
        exams: mergeStudentExamRecords([], rawStudent.exams || [], validExamIds),
      };
      mergedList.push(cleanProfile);
      if (nameSig) byExactName.set(nameSig, idx);
      if (sortedTokens) bySortedTokens.set(sortedTokens, idx);
      if (no) byNo.set(no, idx);
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
    const { state: cleaned, removedDuplicates } = deduplicateArchiveState(parsed);
    if (removedDuplicates > 0) {
      // Automatically persist healed state so duplicates are gone immediately
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
  bundle: ParsedExamBundle
): { nextState: ExamArchiveState; matchedCount: number; newStudentsCount: number } {
  // Always start from a clean deduplicated baseline
  const baseline = deduplicateArchiveState(prev).state;
  const existingExams = [...baseline.exams];
  const nextOrder =
    existingExams.length > 0 ? Math.max(...existingExams.map((e) => e.examOrder)) + 1 : 1;

  const examMeta = {
    ...bundle.examMeta,
    examOrder: nextOrder,
  };

  const studentMap = new Map<string, StudentProfile>();
  const exactNameIndex = new Map<string, string>();
  const sortedTokenNameIndex = new Map<string, string>();

  for (const s of baseline.students) {
    studentMap.set(s.id, {
      ...s,
      sinif: normalizeClassName(s.sinif),
      exams: [...s.exams],
    });
    exactNameIndex.set(buildNameSignature(s.name), s.id);
    sortedTokenNameIndex.set(buildSortedTokensSignature(s.name), s.id);
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

    const incomingSig = buildNameSignature(item.name);
    const incomingSortedTokens = buildSortedTokensSignature(item.name);

    // 1. Exact normalized name match first (most reliable across publishers even when numbers differ)
    let targetId: string | undefined = exactNameIndex.get(incomingSig);

    // 2. Reversed "SOYAD AD" vs "AD SOYAD" token match
    if (!targetId) {
      targetId = sortedTokenNameIndex.get(incomingSortedTokens);
    }

    // 3. Match by Student Key (NO_<numara>) if names are compatible
    if (!targetId && studentMap.has(item.studentKey)) {
      const existingByNo = studentMap.get(item.studentKey)!;
      const existingSig = buildNameSignature(existingByNo.name);
      const dist = editDistance(existingSig, incomingSig);
      const sameTokens = buildSortedTokensSignature(existingByNo.name) === incomingSortedTokens;
      if (sameTokens || dist <= 3 || existingSig.slice(0, 4) === incomingSig.slice(0, 4)) {
        targetId = item.studentKey;
      }
    }

    // 4. Fuzzy 1-2 character match (handles dropped Turkish letters like Ğ/Ş/İ in PDF fonts)
    if (!targetId && incomingSig.length >= 6) {
      for (const [existingId, existingStudent] of studentMap.entries()) {
        if (editDistance(buildNameSignature(existingStudent.name), incomingSig) <= 2) {
          targetId = existingId;
          break;
        }
      }
    }

    const existing = targetId ? studentMap.get(targetId) : undefined;
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
        newId = `${newId}_${incomingSig.slice(0, 6)}`;
      }
      const newProfile: StudentProfile = {
        id: newId,
        numara: item.numara || '0',
        name: item.name.replace(/\s+/g, ' ').trim(),
        sinif: cleanSinif,
        exams: [updatedRecord],
      };
      studentMap.set(newProfile.id, newProfile);
      exactNameIndex.set(incomingSig, newProfile.id);
      sortedTokenNameIndex.set(incomingSortedTokens, newProfile.id);
    }
  }

  const rawNextState: ExamArchiveState = {
    exams: [...existingExams, examMeta],
    students: Array.from(studentMap.values()),
  };

  const { state: nextState } = deduplicateArchiveState(rawNextState);

  return { nextState, matchedCount, newStudentsCount };
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
