import { SUBJECT_MAP, type ExamArchiveState } from '../types/exam';
import type { BranchResult } from './branchAnalysis';
import { branchStudentId, type BranchExam } from './branchHistory';

const archiveKey = 'deneme-analiz:branch-exams:v1';

export function readBranchExams(): BranchExam[] {
  try {
    const saved: BranchExam[] = JSON.parse(localStorage.getItem(archiveKey) || '[]');
    return Array.isArray(saved) ? saved.filter((exam) =>
      exam && typeof exam.id === 'string' && Object.hasOwn(SUBJECT_MAP, exam.subject) && Array.isArray(exam.results)) : [];
  } catch {
    return [];
  }
}

export function updateBranchExams(update: (exams: BranchExam[]) => BranchExam[]) {
  const next = update(readBranchExams());
  localStorage.setItem(archiveKey, JSON.stringify(next));
  return next;
}

export function removeBranchStudent(exams: BranchExam[], studentId: string, examId?: string) {
  return exams.map((exam) => !examId || exam.id === examId
    ? { ...exam, results: exam.results.filter((row) => branchStudentId(row) !== studentId) }
    : exam);
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const scoreCount = (value: unknown) => value === null || count(value);

function isResult(value: unknown): value is BranchResult {
  if (!object(value) || typeof value.name !== 'string' || !value.name.trim() ||
      typeof value.number !== 'string' || typeof value.classroom !== 'string' ||
      !count(value.questionCount) || value.questionCount < 1 || value.questionCount > 500 ||
      !scoreCount(value.correct) || !scoreCount(value.incorrect) || !scoreCount(value.blank) ||
      typeof value.net !== 'number' || !Number.isFinite(value.net)) return false;
  const questionCount = value.questionCount;
  if (value.items !== undefined && (!object(value.items) || !Object.entries(value.items).every(([key, mark]) =>
    /^[1-9]\d*$/.test(key) && Number(key) <= questionCount && (mark === 'D' || mark === 'Y' || mark === 'B')))) return false;
  return value.outcomes === undefined || (Array.isArray(value.outcomes) && value.outcomes.every((row: unknown) =>
    object(row) && typeof row.subject === 'string' && Object.hasOwn(SUBJECT_MAP, row.subject) &&
    typeof row.text === 'string' && count(row.soru) && count(row.dogru) &&
    count(row.yanlis) && count(row.bos) && count(row.basariYuzdesi)));
}

function isExam(value: unknown): value is BranchExam {
  return object(value) && typeof value.id === 'string' && Boolean(value.id) &&
    typeof value.name === 'string' && typeof value.date === 'string' &&
    typeof value.subject === 'string' && Object.hasOwn(SUBJECT_MAP, value.subject) &&
    Array.isArray(value.results) && value.results.every(isResult);
}

export function readBranchBackup(exams: unknown) {
  if (!Array.isArray(exams) || !exams.every(isExam)) {
    throw new Error('Yedekteki branş kayıtları okunamadı. Arşiv değiştirilmedi.');
  }
  return exams;
}

export function makeArchiveJson(state: ExamArchiveState, branchExams = readBranchExams()) {
  return JSON.stringify({ ...state, branchExams }, null, 2);
}

export function readArchiveJson(source: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('JSON yedek dosyası okunamadı.');
  }
  if (!object(raw) || !Array.isArray(raw.exams) || !Array.isArray(raw.students)) {
    throw new Error('Geçerli bir Deneme Arşivi yedeği seçin.');
  }
  const branchExams = Object.hasOwn(raw, 'branchExams') ? readBranchBackup(raw.branchExams) : undefined;
  const state = { exams: raw.exams, students: raw.students } as ExamArchiveState;
  return { state, branchExams };
}

export function mergeBranchBackup(current: BranchExam[], incoming: BranchExam[]) {
  const exams = new Map(current.map((exam) => [exam.id, exam]));
  let addedExams = 0;
  let addedResults = 0;
  for (const exam of incoming) {
    const existing = exams.get(exam.id);
    if (existing && (existing.subject !== exam.subject || existing.date !== exam.date || existing.name !== exam.name)) {
      throw new Error('Yedekteki bir deneme aynı kimliğe sahip mevcut denemeyle uyuşmuyor. Hiçbir kayıt değiştirilmedi.');
    }
    const results = new Map((existing?.results ?? []).map((row) => [branchStudentId(row), row]));
    for (const row of exam.results) {
      const id = branchStudentId(row);
      if (results.has(id)) continue;
      results.set(id, row);
      addedResults++;
    }
    if (!existing) addedExams++;
    exams.set(exam.id, { ...(existing ?? exam), results: [...results.values()] });
  }
  return { exams: [...exams.values()], addedExams, addedResults };
}
