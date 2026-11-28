import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SUBJECT_LIST } from '../src/types/exam';
import { branchLevel, rankBranchStudents, summarizeBranchItems, summarizeBranchOutcomes } from '../src/utils/branchStatistics';
import { parseBranchExcel } from '../src/utils/branchAnalysis';
import {
  branchHistoryChange, branchHistoryStudents, branchStudentHistory, branchSubjectAverages, type BranchExam,
} from '../src/utils/branchHistory';
import { makeArchiveJson, mergeBranchBackup, readArchiveJson, removeBranchStudent } from '../src/utils/branchArchive';
import { branchStudentId } from '../src/utils/branchHistory';
import { parseExamExcel } from '../src/utils/excelHandler';
import { deduplicateArchiveState, EMPTY_ARCHIVE_STATE, mergeExamBundle } from '../src/utils/storage';

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

test('full exams keep every distinct student across Excel sheets and separate exam IDs', async () => {
  const book = XLSX.utils.book_new();
  const sections = ['8-A', '8-B', '8-C'];
  const rows = sections.map((classroom, group) => Array.from({ length: 40 }, (_, index) => [
    index + 1, index < 2 ? 'Deniz Kaya' : `Ogrenci ${group} ${index}`, classroom, ...student.slice(3),
  ]));
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headings, ...rows[0]]), sections[0]);
  sections.slice(1).forEach((classroom, index) => {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headings, ...rows[index + 1]]), classroom);
  });
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headings, ...rows[0]]), 'Okul');
  const source = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const bundle = await parseExamExcel(source, 'okul.xlsx');
  assert.equal(bundle.examMeta.studentCount, 120);
  assert.equal(bundle.records.filter(({ name }) => name === 'Deniz Kaya').length, 6);
  const first = mergeExamBundle(EMPTY_ARCHIVE_STATE, bundle).nextState;
  const second = mergeExamBundle(first, { ...bundle, examMeta: { ...bundle.examMeta, id: 'second_exam' } }).nextState;
  assert.equal(second.students.length, 120);
  assert.equal(new Set(second.students.map(({ id }) => id)).size, 120);
  assert.deepEqual(second.exams.map(({ studentCount }) => studentCount), [120, 120]);
  assert.ok(second.students.every(({ exams }) => exams.length === 2));
  assert.deepEqual(deduplicateArchiveState(second).state.exams.map(({ studentCount }) => studentCount), [120, 120]);
});

async function fullRosterPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const classSections = ['8-A', '8-B', '8-C'];
  for (const classroom of [...classSections, '8-A']) {
    const page = pdf.addPage([820, 842]);
    const write = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 8, font });
    write(`${classroom} SINIFI NET LISTESI`, 30, 800);
    write('O NO', 35, 740);
    write('ADI SOYADI', 78, 740);
    write('SINIF', 162, 740);
    const columns = ['TURKCE', 'TARIH', 'DIN', 'INGILIZCE', 'MATEMATIK', 'FEN'];
    columns.forEach((subject, index) => {
      write(subject, 231 + index * 80, 740);
      ['D', 'Y', 'B', 'N'].forEach((value, sub) => write(value, 212 + index * 80 + sub * 14, 724));
    });
    write('LGS', 695, 740);
    for (let index = 0; index < 30; index++) {
      const y = 700 - index * 20;
      write(String(index + 1), 35, y);
      write(index < 2 ? 'Deniz Kaya' : `Ogrenci ${index}`, 78, y);
      write(classroom, 162, y);
      columns.forEach((_, col) => ['7', '3', '0', '6,00'].forEach((value, sub) => write(value, 212 + col * 80 + sub * 14, y)));
      write('415,00', 695, y);
    }
  }
  const report = pdf.addPage([595, 842]);
  const write = (text: string, x: number, y: number) => report.drawText(text, { x, y, size: 9, font });
  write('SONUC BELGESI', 25, 806);
  write('ADI SOYADI', 25, 720);
  write('NUMARA', 260, 720);
  write('SINIF', 375, 720);
  write('Deniz Kaya', 25, 700);
  write('1', 260, 700);
  write('8-A', 375, 700);
  write('LGS', 25, 677);
  write('415,00', 220, 677);
  return pdf.save();
}

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

async function rankedRosterPdf(inconsistent = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const write = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 6, font });
  write('Sinav Tarihi : 15.11.2026', 45, 802);
  write('ORNEK ORTAOKULU', 45, 770);
  write('PUAN SIRALI LISTE', 240, 770);
  write('SIRA', 22, 755);
  write('NO', 23, 748);
  write('SB', 41, 751);
  write('ADI SOYADI', 85, 751);
  const labels = ['TURKCE', 'MATEMATIK', 'DIN KULTURU', 'FEN BILGISI', 'SOSYAL', 'YABANCI DIL', 'TOPLAM'];
  labels.forEach((label, column) => {
    const start = 152 + column * 42.5;
    if (label === 'SOSYAL') write('BILGILER', start + 6, 751);
    write(label, start + 5, label === 'SOSYAL' ? 759 : 755);
    ['D.', 'Y.', 'N.'].forEach((metric, index) => write(metric, start + [0, 12, 26][index], label === 'SOSYAL' ? 744 : 748));
  });
  write('PUAN', 450, 751);
  ['SB', 'KRM', 'ILCE', 'IL', 'GENEL'].forEach((label, index) => write(label, 478 + index * 20, 755));

  for (const [index, history] of [10, 9].entries()) {
    const y = 735 - index * 13;
    write(String(index + 1), 33, y);
    write('B', 43, y);
    write('Deniz Ornek', 53, y);
    const historyMissed = 10 - history;
    const counts = [
      [19, 1, '18,67'], [18, 2, '17,33'], [10, 0, '10,00'], [15, 5, '13,33'],
      [history, historyMissed, history === 10 ? '10,00' : '8,67'], [9, 1, '8,67'],
      [81 - historyMissed, inconsistent ? 95 : 9 + historyMissed, history === 10 ? '78,00' : '76,67'],
    ];
    counts.forEach((metrics, column) => metrics.forEach((value, metric) =>
      write(String(value), 152 + column * 42.5 + [0, 13, 25][metric], y)));
    write('438,125', 448, y);
    [index + 1, index + 1, 5, 20, 2331].forEach((value, rank) => write(String(value), 485 + rank * 20, y));
  }
  write('ALT ORTALAMALAR', 72, 690);
  write('3,40', 350, 690);
  return pdf.save();
}

test('text PDF imports branch tables and keeps the complete full-exam roster alongside report cards', async () => {
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
    const { parseBranchPdf, parseExamPdf } = await import(pathToFileURL(modulePath).href) as typeof import('../src/utils/pdfParser');
    const fullExam = await parseExamPdf(await fullRosterPdf(), 'karma.pdf');
    assert.equal(fullExam.records.length, 90);
    assert.equal(fullExam.records.filter(({ name }) => name === 'Deniz Kaya').length, 6);
    assert.equal(mergeExamBundle(EMPTY_ARCHIVE_STATE, fullExam).nextState.exams[0].studentCount, 90);
    const ranked = await parseExamPdf(await rankedRosterPdf(), 'puan-sirali.pdf');
    assert.equal(ranked.records.length, 2);
    assert.equal(ranked.examMeta.examDate, '2026-11-15');
    assert.equal(ranked.examMeta.schoolName, 'ORNEK ORTAOKULU');
    assert.deepEqual(ranked.warnings, []);
    assert.deepEqual(ranked.records.map(({ numara, sinif, record }) => [
      numara, sinif, record.subjects.tarih.dogru, record.subjects.tarih.yanlis, record.subjects.tarih.net,
      record.toplam.dogru, record.toplam.yanlis, record.toplam.net, record.lgsPuan, record.dereceler,
    ]), [
      ['0', '8-B', 10, 0, 10, 81, 9, 78, 438.125, { sinif: 1, okul: 1, ilce: 5, il: 20, genel: 2331 }],
      ['0', '8-B', 9, 1, 8.67, 80, 10, 76.67, 438.125, { sinif: 2, okul: 2, ilce: 5, il: 20, genel: 2331 }],
    ]);
    const archived = mergeExamBundle(EMPTY_ARCHIVE_STATE, ranked).nextState;
    assert.equal(deduplicateArchiveState(archived).state.exams[0].studentCount, 2);
    const invalid = await parseExamPdf(await rankedRosterPdf(true), 'hatali-toplam.pdf');
    assert.match(invalid.warnings?.[0] ?? '', /2 satırda/);

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
