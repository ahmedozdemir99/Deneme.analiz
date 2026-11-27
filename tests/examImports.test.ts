import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
import { SUBJECT_LIST } from '../src/types/exam';
import { branchLevel, rankBranchStudents, summarizeBranchAnswerGaps, summarizeBranchItems, summarizeBranchOutcomes } from '../src/utils/branchStatistics';
import { parseBranchExcel } from '../src/utils/branchAnalysis';
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

test('general branch gaps use answer totals without question or outcome data', () => {
  const results = parseBranchExcel(workbook([
    ['Öğrenci No', 'Adı Soyadı', 'Sınıf', 'Doğru', 'Yanlış', 'Boş', 'Net'],
    [101, 'Örnek Öğrenci A', '8A', 18, 2, 0, 17.33],
    [102, 'Örnek Öğrenci B', '8A', 15, 3, 2, 14],
    [103, 'Örnek Öğrenci C', '8A', 12, 5, 3, 10.33],
    [104, 'Örnek Öğrenci D', '8A', 9, 6, 5, 7],
    [201, 'Örnek Öğrenci E', '8B', 20, 0, 0, 20],
    [202, 'Örnek Öğrenci F', '8B', 14, 4, 2, 12.67],
    [203, 'Örnek Öğrenci G', '8B', 11, 5, 4, 9.33],
    [204, 'Örnek Öğrenci H', '8B', 7, 9, 4, 4],
    [300, 'Örnek Öğrenci I', '8C', '', '', '', 10],
  ]), { subject: 'matematik', questionCount: 20 });
  const gaps = summarizeBranchAnswerGaps(results);
  assert.deepEqual(gaps.overall, { correct: 106, incorrect: 34, blank: 20, total: 160, count: 8 });
  assert.deepEqual(gaps.classrooms.map(([classroom, { incorrect, blank }]) => [classroom, incorrect, blank]),
    [['8-A', 16, 10], ['8-B', 18, 10]]);
  assert.equal(gaps.students[0].row.number, '204');
  assert.equal(gaps.students[0].gapRatio, 13 / 20);
  assert.equal(summarizeBranchItems(results).length, 0);
  assert.equal(summarizeBranchOutcomes(results).length, 0);
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
    [-5, 0, 19.99, 20, 39.99, 40, 59.99, 60, 79.99, 80, 100].map((value) => branchLevel(value).label),
    ['Çok kötü', 'Çok kötü', 'Çok kötü', 'Geliştirilmeli', 'Geliştirilmeli', 'Orta', 'Orta', 'İyi', 'İyi', 'Çok iyi', 'Çok iyi'],
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
