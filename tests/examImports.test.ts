import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
import { SUBJECT_LIST } from '../src/types/exam';
import { branchLevel, rankBranchStudents, summarizeBranchItems, summarizeBranchOutcomes } from '../src/utils/branchStatistics';
import { parseBranchExcel } from '../src/utils/branchAnalysis';
import {
  branchHistoryChange, branchHistoryStudents, branchStudentHistory, branchSubjectAverages, type BranchExam,
} from '../src/utils/branchHistory';
import { makeArchiveJson, mergeBranchBackup, readArchiveJson, removeBranchStudent } from '../src/utils/branchArchive';
import { branchStudentId } from '../src/utils/branchHistory';
import { parseExamExcel } from '../src/utils/excelHandler';

function workbook(rows: unknown[][], bookType: 'xlsx' | 'xls' = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Sonuç');
  return XLSX.write(book, { bookType, type: 'array' }) as ArrayBuffer;
}

const subjectLabels = SUBJECT_LIST.map(({ label }) => label);
const student = [3, 'Örnek Öğrenci', '8-B', ...subjectLabels.flatMap(() => [7, 3, null, 6]), 36, 415];
const headings = ['Öğrenci Numarası', 'Ad Soyad', 'Sınıf',
  ...subjectLabels.flatMap((label) => [`${label} Doğru`, `${label} Yanlış`, `${label} Boş`, `${label} Neti`]),
  'Toplam Net', 'LGS Puanı'];

test('full LGS imports XLSX, XLS, Turkish CSV and two-row subject headers', async () => {
  const fixtures = [
    ['tam.xlsx', workbook([headings, student])],
    ['tam.xls', workbook([headings, student], 'xls')],
    ['tam.csv', new TextEncoder().encode(headings.join(';') + '\n' + student.join(';')).buffer],
    ['çift.xlsx', workbook([
      ['Öğrenci Numarası', 'Adı Soyadı', 'Şube', ...subjectLabels.flatMap((label) => [label, '', '', '']), 'Toplam', 'LGS Puanı'],
      ['', '', '', ...subjectLabels.flatMap(() => ['Doğru', 'Yanlış', 'Boş', 'Net']), 'Net', ''],
      student,
    ])],
  ] as const;
  for (const [name, data] of fixtures) {
    const parsed = await parseExamExcel(data, name);
    assert.equal(parsed.records.length, 1);
    const { numara, sinif, record } = parsed.records[0];
    assert.equal(numara, '3');
    assert.equal(sinif, '8-B');
    assert.equal(record.toplam.net, 36);
    assert.equal(record.subjects.fen.net, 6);
    assert.equal(record.lgsPuan, 415);
  }
});

test('branch spreadsheets accept a single subject and keep net-only counts unknown', () => {
  const grouped = workbook([
    ['Öğrenci No', 'Adı Soyadı', 'Sınıf', 'Matematik'],
    ['', '', '', 'D', 'Y', 'B', 'N'],
    [1, 'Örnek Öğrenci', '8A', 11, 3, 1, 10],
  ]);
  const options = { subject: 'matematik', questionCount: 15 } as const;
  const result = parseBranchExcel(grouped, options)[0];
  assert.equal(result.net, 10);
  assert.equal(result.questionCount, 15);
  assert.equal(result.blank, 1);
  assert.throws(() => parseBranchExcel(grouped, { ...options, subject: 'fen' }));
  assert.throws(() => parseBranchExcel(workbook([headings, student]), options));
  const csv = new TextEncoder().encode('Öğrenci No;Adı Soyadı;Matematik Neti\n2;İkinci Öğrenci;10,67');
  const netOnly = parseBranchExcel(csv.buffer, options, 'net.csv')[0];
  assert.equal(netOnly.name, 'İkinci Öğrenci');
  assert.equal(netOnly.net, 10.67);
  assert.equal(netOnly.correct, null);
  assert.equal(netOnly.blank, null);
});

test('branch history orders archived exams, follows the same student and filters subject averages', () => {
  const row = { name: 'Örnek Öğrenci', number: '0101', classroom: '8-A', questionCount: 20, correct: null, incorrect: null, blank: null };
  const exam = (id: string, date: string, subject: BranchExam['subject'], net: number, classroom = '8-A'): BranchExam => ({
    id, date, subject, name: id, results: [{ ...row, classroom, net }],
  });
  const exams = [
    exam('Later upload', '2026-11-20', 'matematik', 14, '8-B'),
    exam('Earlier upload', '2026-11-20', 'matematik', 12),
    exam('Science', '2026-11-01', 'fen', 10),
    exam('First', '2026-10-12', 'matematik', 8),
  ];
  exams[0].results.push({ ...row, number: '202', name: 'Başka Öğrenci', net: 6 });
  const students = branchHistoryStudents(exams);
  assert.equal(students.length, 2);
  const id = students.find(([, student]) => student.number === '0101')![0];
  const history = branchStudentHistory(exams, 'matematik', id);
  assert.deepEqual(history.map(({ id, net }) => [id, net]), [['First', 8], ['Earlier upload', 12], ['Later upload', 14]]);
  assert.equal(branchHistoryChange(history)?.percent, 75);
  assert.equal(branchHistoryChange(history.slice(0, 1)), null);
  assert.equal(branchHistoryChange([{ ...history[0], net: -2 }, history[2]])?.percent, 800);
  assert.equal(branchHistoryChange([{ ...history[0], net: 0 }, history[2]])?.percent, null);
  assert.equal(branchHistoryChange([{ ...history[0], net: 0 }, history[2]])?.difference, 14);
  assert.equal(branchStudentHistory([exam('Invalid', '2026-02-30', 'matematik', 5)], 'matematik', id).length, 0);
  const math = branchSubjectAverages(exams, 'matematik', id);
  assert.equal(math.length, 1);
  assert.equal(math[0].examCount, 3);
  assert.equal(math[0].groupAverage, 10);
  assert.equal(math[0].studentAverage, (8 + 12 + 14) / 3);
  const all = branchSubjectAverages(exams, 'all', id);
  assert.equal(all.find(({ key }) => key === 'fen')?.studentAverage, 10);
  assert.equal(all.find(({ key }) => key === 'turkce')?.groupAverage, null);
});

test('Deneme Arşivi JSON includes branch records, restores missing results and accepts old backups', () => {
  const student = {
    name: 'Örnek Öğrenci', number: '101', classroom: '8-A',
    questionCount: 3, correct: 1, incorrect: 1, blank: 1, net: 0.67,
    items: { 1: 'D', 2: 'B', 3: 'Y' } as const,
    outcomes: [{ subject: 'matematik' as const, text: 'Sayılar', soru: 3, dogru: 1, yanlis: 1, bos: 1, basariYuzdesi: 33 }],
  };
  const other = { ...student, name: 'Başka Öğrenci', number: '102' };
  const exam: BranchExam = { id: 'math-1', name: 'Matematik 1', date: '2026-11-24', subject: 'matematik', results: [student, other] };
  const exams = [exam, { ...exam, id: 'math-2' }];
  const state = { exams: [], students: [] };
  const backup = readArchiveJson(makeArchiveJson(state, exams));
  assert.deepEqual(backup.state, state);
  assert.deepEqual(backup.branchExams, exams);
  assert.equal(readArchiveJson(JSON.stringify(state)).branchExams, undefined);
  assert.throws(() => readArchiveJson(JSON.stringify({ ...state, branchExams: [{ ...exam, results: [{ ...student, items: { 9: 'D' } }] }] })));
  const identity = branchStudentId(student);
  const single = removeBranchStudent(exams, identity, exam.id);
  assert.deepEqual(single.map((item) => item.results.length), [1, 2]);
  assert.deepEqual(removeBranchStudent(exams, identity).map((item) => item.results.length), [1, 1]);
  const restored = mergeBranchBackup(single, backup.branchExams!);
  assert.equal(restored.addedExams, 0);
  assert.equal(restored.addedResults, 1);
  assert.deepEqual(restored.exams[0].results, [other, student]);
  assert.equal(mergeBranchBackup(restored.exams, backup.branchExams!).addedResults, 0);
  assert.equal(mergeBranchBackup([exam], exams).addedExams, 1);
  assert.throws(() => mergeBranchBackup(exams, [{ ...exam, name: 'Farklı deneme' }]), /değiştirilmedi/);
});

test('branch item results support rank ties, difficulty, discrimination and imported outcomes', () => {
  const headers = ['Öğrenci No', 'Adı Soyadı', 'Sınıf', 'S1', 'S2', 'Soru 3', '4. Soru'];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    headers,
    [1, 'Örnek Öğrenci A', '8A', 'D', 'D', 'D', 'D'],
    [2, 'Örnek Öğrenci B', '8A', 'D', 'D', 'Y', 'B'],
    [3, 'Örnek Öğrenci C', '8B', 'Y', 'Y', 'D', 'B'],
    [4, 'Örnek Öğrenci D', '8B', 'B', 'Y', 'B', 'B'],
  ]), 'Sonuçlar');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Soru', 'Kazanım'], [1, 'Sayılar'], [2, 'Sayılar'], [3, 'Geometri'],
  ]), 'Kazanımlar');
  const options = { subject: 'matematik', questionCount: 4 } as const;
  const results = parseBranchExcel(XLSX.write(book, { type: 'array', bookType: 'xlsx' }), options);
  assert.deepEqual(results.map(({ net }) => net), [4, 1.67, 0.33, -0.33]);
  assert.deepEqual(summarizeBranchOutcomes(results).map(({ title, rate, students }) => [title, rate, students]),
    [['Geometri', 0.5, 4], ['Sayılar', 0.5, 4]]);
  const items = summarizeBranchItems(results);
  assert.deepEqual(items.map(({ count, correct, incorrect, blank }) => [count, correct, incorrect, blank]),
    [[4, 2, 1, 1], [4, 2, 2, 0], [4, 2, 1, 1], [4, 1, 0, 3]]);
  assert.equal(items[0].difficulty, 0.5);
  assert.ok((items[0].discrimination ?? -1) > 0);
  assert.equal(summarizeBranchItems(results.slice(0, 3))[0].discrimination, null);
  assert.equal(summarizeBranchItems(results.map((row) => ({ ...row, items: undefined }))).length, 0);
  const incomplete = parseBranchExcel(workbook([
    ['Öğrenci No', 'Adı Soyadı', 'Net', 'S1', 'S2'],
    [5, 'Örnek Öğrenci E', 2, 'D', ''],
  ]), options);
  assert.deepEqual(incomplete[0].items, { 1: 'D' });
  assert.equal(incomplete[0].blank, null);
  assert.equal(summarizeBranchItems(incomplete)[0].count, 1);
  assert.throws(() => parseBranchExcel(workbook([
    ['Adı Soyadı', 'Doğru', 'Yanlış', 'S1', 'S2', 'S3', 'S4'],
    ['Örnek Öğrenci', 2, 2, 'D', 'D', 'D', 'D'],
  ]), options), /uyuşmuyor/);
  const tied = [{ ...results[0], net: 2 }, { ...results[1], net: 2 }, { ...results[2], net: 2 }, results[3]];
  assert.deepEqual(rankBranchStudents(tied).map(({ rank }) => rank), [1, 1, 1, 4]);
  assert.deepEqual(
    [-5, 0, 37.99, 38, 53.99, 54, 69.99, 70, 84.99, 85, 100].map((value) => branchLevel(value).label),
    ['Kötü', 'Kötü', 'Kötü', 'Geliştirilmeli', 'Geliştirilmeli', 'Orta', 'Orta', 'İyi', 'İyi', 'Çok iyi', 'Çok iyi'],
  );
  assert.deepEqual(
    [-5, 0, 38, 53.99, 54, 85].map((value) => branchLevel(value).needsSupport),
    [true, true, true, true, false, false],
  );
});

function textPdf(rows: string[][]) {
  const columns = [32, 90, 255, 315, 375, 430, 485, 540];
  const stream = rows.flatMap((row, index) => row.map((cell, column) =>
    `BT /F1 10 Tf ${columns[column]} ${730 - 25 * index} Td (${cell}) Tj ET`)).join('\n') + '\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map((offset) =>
    String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return new TextEncoder().encode(pdf + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`).buffer;
}

test('text PDF branch tables import from one or two header rows', async () => {
  const dir = await mkdtemp(path.resolve('tests/.exam-imports-'));
  try {
    const modulePath = path.join(dir, 'pdf.mjs');
    await build({
      entryPoints: ['src/utils/pdfParser.ts'], outfile: modulePath, bundle: true, platform: 'node',
      format: 'esm', packages: 'external',
      plugins: [{ name: 'node-pdf-worker', setup(api) {
        api.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: 'pdfjs-dist/legacy/build/pdf.mjs', external: true }));
        api.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({ path: 'worker', namespace: 'test' }));
        api.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: "export default import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');",
        }));
      } }],
    });
    const { parseBranchPdf } = await import(pathToFileURL(modulePath).href) as typeof import('../src/utils/pdfParser');
    const row = ['42', 'Ornek Ogrenci', '8-A', '20', '15', '3', '2', '14,00'];
    const options = { subject: 'matematik', questionCount: 20 } as const;
    for (const headers of [
      [['Ogrenci No', 'Adi Soyadi', 'Sinif', 'Soru', 'Dogru', 'Yanlis', 'Bos', 'Net']],
      [['Ogrenci No', 'Adi Soyadi', 'Sinif', 'Matematik'], ['', '', '', 'Soru', 'Dogru', 'Yanlis', 'Bos', 'Net']],
    ]) {
      const parsed = await parseBranchPdf(textPdf([...headers, row]), options);
      assert.deepEqual(parsed.map(({ number, net, blank }) => [number, net, blank]), [['42', 14, 2]]);
    }
    const questionData = await parseBranchPdf(textPdf([
      ['Ogrenci No', 'Adi Soyadi', 'Sinif', 'S1', 'S2', 'S3', 'S4'],
      ['42', 'Ornek Ogrenci', '8-A', 'D', 'Y', 'B', 'D'],
    ]), { ...options, questionCount: 4 });
    assert.deepEqual(questionData[0].items, { 1: 'D', 2: 'Y', 3: 'B', 4: 'D' });
    assert.equal(questionData[0].net, 1.67);
    for (const headers of [
      ['', '', '', '#', 'Anaht', 'Stu', 'Pts', 'Poss'],
      ['', '', '', '# Key', '', 'Stu', 'Pts Poss', ''],
    ]) {
      const zipGrade = textPdf([
        headers,
        ['Ogrenci:', 'Ornek Ogrenci', '', '1', 'A', 'A', '1.0', '1.0'],
        ['', '', '', '2', 'A', 'B', '0.0', '1.0'],
        ['', '', '', '3', 'C', '', '0.0', '1.0'],
        ['', '', '', '4', 'A', 'A', '1.0', '1.0'],
      ]);
      const [result] = await parseBranchPdf(zipGrade.slice(0), { ...options, questionCount: 4, defaultClassroom: '8B' });
      assert.deepEqual(result.items, { 1: 'D', 2: 'Y', 3: 'B', 4: 'D' });
      assert.deepEqual([result.classroom, result.correct, result.incorrect, result.blank, result.net], ['8-B', 2, 1, 1, 1.67]);
      await assert.rejects(parseBranchPdf(zipGrade.slice(0), options), /ZipGrade sayfasında 4 soru/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
