import * as XLSX from 'xlsx';
import { SUBJECT_MAP, type KazanimResult, type SubjectKey } from '../types/exam';
import { buildStudentKey, matchSubjectLabel, normalizeClassName, normalizeTurkish } from './examLabels';
import { parseCellNumber, readResultsWorkbook } from './excelHandler';

export interface BranchOptions {
  subject: SubjectKey;
  questionCount: number;
}

export interface BranchResult {
  name: string;
  number: string;
  classroom: string;
  questionCount: number;
  correct: number | null;
  incorrect: number | null;
  blank: number | null;
  net: number;
  outcomes?: KazanimResult[];
}

export type BranchSourceRow = {
  name: string;
  number?: string;
  classroom?: string;
  questionCount?: unknown;
  correct?: unknown;
  incorrect?: unknown;
  blank?: unknown;
  net?: unknown;
  outcomes?: KazanimResult[];
};

export type BranchColumn = Exclude<keyof BranchSourceRow, 'outcomes'>;

export function branchColumn(value: string, subject: SubjectKey): BranchColumn | undefined {
  const heading = normalizeTurkish(value);
  if (/^(?:(?:OGRENCI |OGR )?(?:ADI? SOYADI?|ADI?|ISIM)|OGRENCI)$/.test(heading)) return 'name';
  if (/^(O NO|ONO|OGR NO|OGRENCI (?:NO(?:SU)?|NUMARA(?:SI)?)|NUMARA|OKUL (?:NO(?:SU)?|NUMARA(?:SI)?)|NO)$/.test(heading)) return 'number';
  if (/^(SINIF|SINIFI|SUBE|SINIF SUBE|SNF)$/.test(heading)) return 'classroom';

  const metric = heading.match(/^(?:(.+) )?(SORU SAYISI|SORU|S|DOGRU|DOG|D|YANLIS|YAN|Y|BOS|B|NETI|NET|N)$/);
  if (!metric) return matchSubjectLabel(heading) === subject ? 'net' : undefined;
  if (metric[1] && matchSubjectLabel(metric[1]) !== subject) return undefined;
  if (/^(SORU SAYISI|SORU|S)$/.test(metric[2])) return 'questionCount';
  if (/^(DOGRU|DOG|D)$/.test(metric[2])) return 'correct';
  if (/^(YANLIS|YAN|Y)$/.test(metric[2])) return 'incorrect';
  if (/^(BOS|B)$/.test(metric[2])) return 'blank';
  return 'net';
}

export function validBranchColumns(columns: Iterable<BranchColumn>) {
  const found = new Set(columns);
  return found.has('name') && (found.has('net') || (found.has('correct') && found.has('incorrect')));
}

export function buildBranchResults(rows: BranchSourceRow[], options: BranchOptions): BranchResult[] {
  if (!Number.isInteger(options.questionCount) || options.questionCount < 1 || options.questionCount > 500) {
    throw new Error('Soru sayısı 1 ile 500 arasında bir tam sayı olmalıdır.');
  }
  const results = new Map<string, BranchResult>();
  for (const row of rows) {
    const name = row.name.trim();
    const normalized = normalizeTurkish(name);
    if (!/^[A-Z]+(?: [A-Z]+)+/.test(normalized) ||
      /^(?:OGRENCI|ADI SOYADI|AD SOYAD|OKUL|KURUM|SINIF|SUBE|GENEL|TOPLAM|ORTALAMA)\b/.test(normalized)) continue;
    const questionCount = parseCellNumber(row.questionCount) ?? options.questionCount;
    const correct = parseCellNumber(row.correct);
    const incorrect = parseCellNumber(row.incorrect);
    const reportedBlank = parseCellNumber(row.blank);
    const reportedNet = parseCellNumber(row.net);
    const counts = [correct, incorrect, reportedBlank].filter((n): n is number => n !== null);
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 500 ||
      counts.some((n) => !Number.isInteger(n) || n < 0) ||
      counts.reduce((a, b) => a + b, 0) > questionCount) {
      throw new Error(`${name} satırındaki soru ve cevap sayıları birbiriyle uyuşmuyor.`);
    }
    const blank = reportedBlank ?? (correct !== null && incorrect !== null ? questionCount - correct - incorrect : null);
    const net = reportedNet ?? (correct !== null && incorrect !== null ? Math.round((correct - incorrect / 3) * 100) / 100 : null);
    if (net === null) continue;
    if (net > questionCount || net < -questionCount) throw new Error(`${name} satırında geçersiz net değeri var.`);
    const number = row.number?.replace(/\D/g, '') ?? '';
    const classroom = row.classroom?.trim() ? normalizeClassName(row.classroom) : '';
    const key = buildStudentKey(number, name, classroom);
    const outcome = row.outcomes?.filter((item) => item.subject === options.subject);
    if (!results.has(key)) results.set(key, {
      name, number, classroom, questionCount, correct, incorrect, blank, net,
      outcomes: outcome?.length ? outcome : undefined,
    });
  }
  return [...results.values()];
}

export function parseBranchExcel(source: ArrayBuffer, options: BranchOptions, fileName = ''): BranchResult[] {
  const workbook = readResultsWorkbook(source, fileName);
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
    for (let r = 0; r < Math.min(60, rows.length); r++) {
      const header = rows[r];
      const next = rows[r + 1] ?? [];
      let group: SubjectKey | null = null;
      const twoRows = next.filter((cell) => /^(D|DOGRU|Y|YANLIS|B|BOS|N|NET|SORU)$/.test(normalizeTurkish(String(cell)))).length >= 2;
      const columns = new Map<BranchColumn, number>();
      const detectedSubjects = new Set<SubjectKey>();
      for (let c = 0; c < Math.max(header.length, twoRows ? next.length : 0); c++) {
        const top = String(header[c] ?? '');
        const bottom = twoRows ? String(next[c] ?? '') : '';
        const explicit = matchSubjectLabel(normalizeTurkish(top).replace(/\s+(SORU|D|DOGRU|Y|YANLIS|B|BOS|N|NET|NETI)$/, ''));
        if (explicit) detectedSubjects.add(explicit);
        if (top.trim()) group = explicit;
        const label = group ? `${SUBJECT_MAP[group].label} ${bottom}` : bottom;
        const column = bottom ? branchColumn(label, options.subject) ?? branchColumn(top, options.subject) : branchColumn(top, options.subject);
        if (column && !columns.has(column)) columns.set(column, c);
      }
      if (detectedSubjects.size > 1 || (detectedSubjects.size && !detectedSubjects.has(options.subject)) || !validBranchColumns(columns.keys())) continue;
      const value = (row: unknown[], column: BranchColumn) => row[columns.get(column) ?? -1];
      const results = buildBranchResults(rows.slice(r + (twoRows ? 2 : 1)).map((row) => ({
        name: String(value(row, 'name') ?? ''), number: String(value(row, 'number') ?? ''),
        classroom: String(value(row, 'classroom') ?? ''), questionCount: value(row, 'questionCount'),
        correct: value(row, 'correct'), incorrect: value(row, 'incorrect'), blank: value(row, 'blank'), net: value(row, 'net'),
      })), options);
      if (results.length) return results;
    }
  }
  throw new Error('Seçilen ders için öğrenci adı ve net ya da doğru/yanlış sütunları bulunamadı.');
}

export function downloadBranchTemplate() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Öğrenci No', 'Adı Soyadı', 'Sınıf', 'Soru', 'Doğru', 'Yanlış', 'Boş', 'Net'],
    [101, 'Örnek Öğrenci', '8-A', 20, 15, 3, 2, 14],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Branş Sonuçları');
  XLSX.writeFile(workbook, 'Brans_Deneme_Sablonu.xlsx');
}
