import { SUBJECT_LIST, type SubjectKey } from '../types/exam';
import type { BranchResult } from './branchAnalysis';
import { normalizeTurkish } from './examLabels';

export interface BranchExam {
  id: string;
  name: string;
  date: string;
  subject: SubjectKey;
  results: BranchResult[];
}

export function branchStudentId(row: BranchResult) {
  const name = normalizeTurkish(row.name);
  const number = row.number.replace(/^0+/, '');
  return number ? `number:${number}:${name}` : `name:${name}:${normalizeTurkish(row.classroom)}`;
}

export function branchHistoryStudents(exams: BranchExam[]) {
  const students = new Map<string, BranchResult>();
  for (const exam of exams) {
    for (const row of exam.results) {
      const id = branchStudentId(row);
      if (!students.has(id)) students.set(id, row);
    }
  }
  return [...students].sort(([, a], [, b]) => a.name.localeCompare(b.name, 'tr') ||
    a.number.localeCompare(b.number, 'tr', { numeric: true }));
}

function validDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date;
}

export function branchStudentHistory(exams: BranchExam[], subject: SubjectKey, studentId: string) {
  // The archive stores newest uploads first. Reverse it for exams on the same date.
  return [...exams].reverse().filter((exam) => exam.subject === subject && validDate(exam.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((exam) => {
      const student = exam.results.find((row) => branchStudentId(row) === studentId);
      return student && Number.isFinite(student.net)
        ? [{ id: exam.id, date: exam.date, name: exam.name, net: student.net }]
        : [];
    });
}

export function branchHistoryChange(history: ReturnType<typeof branchStudentHistory>) {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || history.length < 2) return null;
  const difference = last.net - first.net;
  const percent = first.net === 0 ? null : difference / Math.abs(first.net) * 100;
  return { first, last, difference, percent };
}

export function branchSubjectAverages(exams: BranchExam[], filter: SubjectKey | 'all', studentId: string) {
  return SUBJECT_LIST.filter(({ key }) => filter === 'all' || filter === key).map(({ key, label }) => {
    let groupNet = 0, studentNet = 0, groupCount = 0, studentCount = 0, examCount = 0;
    for (const exam of exams) {
      if (exam.subject !== key) continue;
      const validResults = exam.results.filter((row) => Number.isFinite(row.net));
      if (validResults.length) examCount++;
      for (const row of validResults) {
        groupNet += row.net;
        groupCount++;
        if (branchStudentId(row) === studentId) {
          studentNet += row.net;
          studentCount++;
        }
      }
    }
    return {
      key, label, examCount, groupCount, studentCount,
      groupAverage: groupCount ? groupNet / groupCount : null,
      studentAverage: studentCount ? studentNet / studentCount : null,
    };
  });
}
