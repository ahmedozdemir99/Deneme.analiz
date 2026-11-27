import * as XLSX from 'xlsx';
import { SUBJECT_MAP, type KazanimResult, type SubjectKey } from '../types/exam';
import { buildStudentKey, matchSubjectLabel, normalizeClassName, normalizeTurkish } from './examLabels';
import { parseCellNumber, readResultsWorkbook } from './excelHandler';

export interface BranchOptions {
  subject: SubjectKey;
  questionCount: number;
  defaultClassroom?: string;
}

export type BranchMark = 'D' | 'Y' | 'B';
export type BranchItems = Partial<Record<number, BranchMark>>;

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
  items?: BranchItems;
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
  items?: BranchItems;
  itemTopics?: Map<number, string>;
};

export type BranchColumn = Exclude<keyof BranchSourceRow, 'outcomes' | 'items' | 'itemTopics'>;
export type BranchTableColumn = BranchColumn | `question:${number}`;

export function branchQuestionColumn(value: string): `question:${number}` | undefined {
  const match = normalizeTurkish(value).match(/^(?:S ?(\d{1,3})|SORU ?(\d{1,3})|(\d{1,3}) (?:SORU|S))$/);
  const question = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return question >= 1 && question <= 500 ? `question:${question}` : undefined;
}

export function readBranchItems(columns: Iterable<[BranchTableColumn, unknown]>): BranchItems | undefined {
  const items: BranchItems = {};
  for (const [key, value] of columns) {
    if (!key.startsWith('question:')) continue;
    const question = Number(key.slice('question:'.length));
    const mark = normalizeTurkish(String(value ?? ''));
    if (mark === 'D' || mark === 'DOGRU') items[question] = 'D';
    if (mark === 'Y' || mark === 'YANLIS') items[question] = 'Y';
    if (mark === 'B' || mark === 'BOS') items[question] = 'B';
  }
  return Object.keys(items).length ? items : undefined;
}

function outcomesFromItems(items: BranchItems | undefined, topics: Map<number, string> | undefined, subject: SubjectKey) {
  const result = new Map<string, KazanimResult>();
  if (!items || !topics) return [];
  for (const [question, topic] of topics) {
    const mark = items[question];
    if (!mark) continue;
    const outcome = result.get(topic) ?? { subject, text: topic, soru: 0, dogru: 0, yanlis: 0, bos: 0, basariYuzdesi: 0 };
    outcome.soru++;
    if (mark === 'D') outcome.dogru++;
    if (mark === 'Y') outcome.yanlis++;
    if (mark === 'B') outcome.bos++;
    outcome.basariYuzdesi = Math.round(outcome.dogru / outcome.soru * 100);
    result.set(topic, outcome);
  }
  return [...result.values()];
}

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

export function validBranchColumns(columns: Iterable<BranchTableColumn>) {
  const found = new Set(columns);
  return found.has('name') && (found.has('net') || (found.has('correct') && found.has('incorrect')) || [...found].some((column) => column.startsWith('question:')));
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
    const items = row.items ?? {};
    const marks = Object.values(items);
    if (Object.keys(items).some((key) => Number(key) > questionCount)) {
      throw new Error(`${name} satırındaki soru numarası, denemenin soru sayısını aşıyor.`);
    }
    const count = (mark: BranchMark) => marks.filter((value) => value === mark).length;
    const complete = marks.length === questionCount;
    const metrics = [
      [parseCellNumber(row.correct), count('D')],
      [parseCellNumber(row.incorrect), count('Y')],
      [parseCellNumber(row.blank), count('B')],
    ] as const;
    if (metrics.some(([reported, observed]) => reported !== null && (observed > reported || (complete && observed !== reported)))) {
      throw new Error(`${name} satırındaki soru işaretleri doğru, yanlış veya boş toplamıyla uyuşmuyor.`);
    }
    const [correct, incorrect, reportedBlank] = metrics.map(([reported, observed]) => reported ?? (complete ? observed : null));
    const reportedNet = parseCellNumber(row.net);
    const counts = [correct, incorrect, reportedBlank].filter((n): n is number => n !== null);
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 500 ||
      counts.some((n) => !Number.isInteger(n) || n < 0) ||
      counts.reduce((a, b) => a + b, 0) > questionCount) {
      throw new Error(`${name} satırındaki soru ve cevap sayıları birbiriyle uyuşmuyor.`);
    }
    const blank = reportedBlank ?? (correct !== null && incorrect !== null ? questionCount - correct - incorrect : null);
    const net = reportedNet ?? (correct !== null && incorrect !== null ? Math.round((correct - incorrect / 3) * 100) / 100 : null);
    if (net === null) {
      if (marks.length) throw new Error(`${name} satırında eksik soru işareti var. Net veya doğru/yanlış toplamını ekleyin ya da bütün soruları D, Y veya B olarak işaretleyin.`);
      continue;
    }
    if (net > questionCount || net < -questionCount) throw new Error(`${name} satırında geçersiz net değeri var.`);
    const number = row.number?.replace(/\D/g, '') ?? '';
    const providedClassroom = row.classroom?.trim() || options.defaultClassroom?.trim();
    const classroom = providedClassroom ? normalizeClassName(providedClassroom) : '';
    const key = buildStudentKey(number, name, classroom);
    const outcome = row.outcomes?.filter((item) => item.subject === options.subject) ?? outcomesFromItems(items, row.itemTopics, options.subject);
    if (!results.has(key)) results.set(key, {
      name, number, classroom, questionCount, correct, incorrect, blank, net,
      outcomes: outcome.length ? outcome : undefined, items: marks.length ? items : undefined,
    });
  }
  return [...results.values()];
}

export function parseBranchExcel(source: ArrayBuffer, options: BranchOptions, fileName = ''): BranchResult[] {
  const workbook = readResultsWorkbook(source, fileName);
  const topicSheet = workbook.SheetNames.find((name) => normalizeTurkish(name) === 'KAZANIMLAR');
  const itemTopics = new Map<number, string>();
  if (topicSheet) {
    const topicRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[topicSheet], { header: 1, blankrows: false });
    const [head, ...entries] = topicRows;
    if (head && normalizeTurkish(String(head[0])) === 'SORU' && normalizeTurkish(String(head[1])) === 'KAZANIM') {
      for (const [index, value] of entries) {
        const question = parseCellNumber(index);
        const topic = typeof value === 'string' ? value.trim() : '';
        if (question !== null && Number.isInteger(question) && question >= 1 && question <= 500 && topic) itemTopics.set(question, topic);
      }
    }
  }
  for (const sheetName of workbook.SheetNames) {
    if (sheetName === topicSheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
    for (let r = 0; r < Math.min(60, rows.length); r++) {
      const header = rows[r];
      const next = rows[r + 1] ?? [];
      let group: SubjectKey | null = null;
      const nameColumn = header.findIndex((cell) => branchColumn(String(cell), options.subject) === 'name');
      const nextName = String(next[nameColumn] ?? '').trim();
      const twoRows = (!nextName || branchColumn(nextName, options.subject) === 'name') &&
        next.filter((cell) => /^(D|DOGRU|Y|YANLIS|B|BOS|N|NET|SORU)$/.test(normalizeTurkish(String(cell)))).length >= 2;
      const columns = new Map<BranchTableColumn, number>();
      const detectedSubjects = new Set<SubjectKey>();
      for (let c = 0; c < Math.max(header.length, twoRows ? next.length : 0); c++) {
        const top = String(header[c] ?? '');
        const bottom = twoRows ? String(next[c] ?? '') : '';
        const explicit = matchSubjectLabel(normalizeTurkish(top).replace(/\s+(SORU|D|DOGRU|Y|YANLIS|B|BOS|N|NET|NETI)$/, ''));
        if (explicit) detectedSubjects.add(explicit);
        if (top.trim()) group = explicit;
        const label = group ? `${SUBJECT_MAP[group].label} ${bottom}` : bottom;
        const column = branchQuestionColumn(top) ?? (bottom ? branchColumn(label, options.subject) ?? branchColumn(top, options.subject) : branchColumn(top, options.subject));
        if (column && !columns.has(column)) columns.set(column, c);
      }
      if (detectedSubjects.size > 1 || (detectedSubjects.size && !detectedSubjects.has(options.subject)) || !validBranchColumns(columns.keys())) continue;
      const value = (row: unknown[], column: BranchColumn) => row[columns.get(column) ?? -1];
      const results = buildBranchResults(rows.slice(r + (twoRows ? 2 : 1)).map((row) => ({
        name: String(value(row, 'name') ?? ''), number: String(value(row, 'number') ?? ''),
        classroom: String(value(row, 'classroom') ?? ''), questionCount: value(row, 'questionCount'),
        correct: value(row, 'correct'), incorrect: value(row, 'incorrect'), blank: value(row, 'blank'), net: value(row, 'net'),
        items: readBranchItems([...columns].map(([key, index]) => [key, row[index]])), itemTopics,
      })), options);
      if (results.length) return results;
    }
  }
  throw new Error('Öğrenci adıyla birlikte net, doğru/yanlış toplamı veya D/Y/B işaretli soru sütunları bulunamadı.');
}

export function downloadBranchTemplate(questionCount: number) {
  const count = Number.isInteger(questionCount) ? Math.min(500, Math.max(1, questionCount)) : 20;
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Öğrenci No', 'Adı Soyadı', 'Sınıf', 'Soru', 'Doğru', 'Yanlış', 'Boş', 'Net',
      ...Array.from({ length: count }, (_, index) => `S${index + 1}`)],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Branş Sonuçları');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Soru', 'Kazanım'], ...Array.from({ length: count }, (_, index) => [index + 1]),
  ]), 'Kazanımlar');
  XLSX.writeFile(workbook, 'Brans_Deneme_Sablonu.xlsx');
}
