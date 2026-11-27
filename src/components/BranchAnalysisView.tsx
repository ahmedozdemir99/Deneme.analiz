import { useMemo, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { SUBJECT_LIST, SUBJECT_MAP, type SubjectKey } from '../types/exam';
import { downloadBranchTemplate, parseBranchExcel } from '../utils/branchAnalysis';
import type { BranchExam } from '../utils/branchHistory';
import { BranchHistory } from './BranchHistory';
import { BranchReport } from './BranchReport';
import { parseBranchPdf } from '../utils/pdfParser';

const archiveKey = 'deneme-analiz:branch-exams:v1';
const field = 'mt-1 block min-h-10 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const panel = 'rounded-xl border border-slate-200 bg-white p-4 sm:p-5';

function readBranchExams(): BranchExam[] {
  try {
    const saved: BranchExam[] = JSON.parse(localStorage.getItem(archiveKey) || '[]');
    return Array.isArray(saved) ? saved.filter((exam) =>
      exam && typeof exam.id === 'string' && Object.hasOwn(SUBJECT_MAP, exam.subject) && Array.isArray(exam.results)) : [];
  } catch {
    return [];
  }
}

export function BranchAnalysisView() {
  const [exams, setExams] = useState(readBranchExams);
  const [examId, setExamId] = useState(() => exams[0]?.id ?? '');
  const [filter, setFilter] = useState<SubjectKey | 'all'>('all');
  const [subject, setSubject] = useState<SubjectKey>('matematik');
  const [questionCount, setQuestionCount] = useState(SUBJECT_MAP.matematik.questionCount);
  const [file, setFile] = useState<File | null>(null);
  const [classroom, setClassroom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filteredExams = useMemo(() => filter === 'all' ? exams : exams.filter((item) => item.subject === filter), [exams, filter]);
  const exam = filteredExams.find((item) => item.id === examId) ?? filteredExams[0];
  const classrooms = useMemo(
    () => [...new Set(exam?.results.map((row) => row.classroom).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')),
    [exam],
  );
  const results = useMemo(
    () => classroom ? exam?.results.filter((row) => row.classroom === classroom) ?? [] : exam?.results ?? [],
    [exam, classroom],
  );

  return (
    <div className="space-y-5">
      {exams.length > 0 && <BranchHistory exams={exams} filter={filter} onFilterChange={(value) => {
        setFilter(value);
        setClassroom('');
      }} />}
      <section className={panel}>
        <h1 className="text-xl font-bold text-slate-900">Branş Denemesi Analizi</h1>
        <p className="mt-1 text-sm text-slate-600">Tek dersin metin tabanlı PDF sonuç listesini veya Excel dosyasını yükleyin. Soru bazında analiz için S1, S2, … sütunlarına D, Y veya B yazın. Branş sonuçları bu tarayıcıda kendi arşivine kaydedilir.</p>
        <form className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={async (event) => {
          event.preventDefault();
          if (!file || busy) return;
          const form = event.currentTarget;
          const formData = new FormData(form);
          const name = String(formData.get('examName') ?? '').trim() || file.name.replace(/\.[^.]+$/, '');
          const date = String(formData.get('examDate') ?? '');
          const options = { subject, questionCount };
          setBusy(true);
          setError('');
          try {
            if (!/\.(pdf|xlsx?|csv)$/i.test(file.name)) throw new Error('PDF, XLSX, XLS veya CSV dosyası seçin.');
            const source = await file.arrayBuffer();
            const parsed = /\.pdf$/i.test(file.name)
              ? await parseBranchPdf(source, options)
              : parseBranchExcel(source, options, file.name);
            const item: BranchExam = { id: crypto.randomUUID(), name, date, subject, results: parsed };
            const next = [item, ...readBranchExams()];
            localStorage.setItem(archiveKey, JSON.stringify(next));
            setExams(next);
            setExamId(item.id);
            if (filter !== 'all') setFilter(subject);
            setClassroom('');
            setFile(null);
            form.reset();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Branş sonuçları okunamadı.');
          } finally {
            setBusy(false);
          }
        }}>
          <label className="text-sm font-semibold">Ders
            <select value={subject} disabled={busy} className={field} onChange={(event) => {
              const value = event.target.value as SubjectKey;
              setSubject(value);
              setQuestionCount(SUBJECT_MAP[value].questionCount);
            }}>
              {SUBJECT_LIST.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold">Soru sayısı
            <input type="number" min={1} max={500} value={questionCount || ''} required className={field} disabled={busy}
              onChange={(event) => setQuestionCount(Number(event.target.value))} />
          </label>
          <label className="text-sm font-semibold">Sınav tarihi
            <input type="date" name="examDate" defaultValue={new Date().toLocaleDateString('en-CA')} required className={field} disabled={busy} />
          </label>
          <label className="text-sm font-semibold">Deneme adı
            <input name="examName" maxLength={160} placeholder="Boşsa dosya adı kullanılır" className={field} disabled={busy} />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">Sonuç dosyası
            <input type="file" accept=".pdf,.xlsx,.xls,.csv" className={field} disabled={busy} required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
            <button type="submit" disabled={busy || !file}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white disabled:opacity-60">
              <FileUp aria-hidden="true" className="size-4" /> {busy ? 'Okunuyor…' : 'Analiz et ve kaydet'}
            </button>
            <button type="button" onClick={() => downloadBranchTemplate(questionCount)} className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-blue-700 underline">
              <Download aria-hidden="true" className="size-4" /> Branş Excel şablonu
            </button>
          </div>
          {error && <p role="alert" className="text-sm font-medium text-red-700 sm:col-span-2 lg:col-span-3">{error}</p>}
        </form>
      </section>

      {exam && <section className={panel}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-sm font-semibold">Branş arşivi
            <select value={exam.id} className={field} onChange={(event) => {
              setExamId(event.target.value);
              setClassroom('');
            }}>
              {filteredExams.map((item) => <option key={item.id} value={item.id}>{item.name} · {SUBJECT_MAP[item.subject].label} · {item.date}</option>)}
            </select>
          </label>
          {classrooms.length > 0 && <label className="text-sm font-semibold">Sınıf
            <select className={field} value={classroom} onChange={(event) => setClassroom(event.target.value)}>
              <option value="">Tümü</option>
              {classrooms.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>}
        </div>
        <h2 className="mt-4 font-semibold text-slate-900">{SUBJECT_MAP[exam.subject].label} · {exam.name}</h2>
        <BranchReport key={exam.id} allRows={exam.results} rows={results} />
      </section>}
    </div>
  );
}
