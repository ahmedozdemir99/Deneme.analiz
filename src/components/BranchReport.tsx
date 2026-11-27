import { useMemo, useState } from 'react';
import { formatTrNumber } from '../utils/analytics';
import type { BranchResult } from '../utils/branchAnalysis';
import {
  BRANCH_LEVELS, branchLevel, branchPercent, rankBranchStudents, summarizeBranchItems, summarizeBranchOutcomes,
  summarizeBranchScores,
} from '../utils/branchStatistics';
import { normalizeTurkish } from '../utils/examLabels';

const tabs = ['Sıralama', 'Eksik analizi', 'Madde analizi'] as const;
const levelColors = {
  'very-good': 'bg-emerald-100 text-emerald-900',
  good: 'bg-sky-100 text-sky-900',
  medium: 'bg-amber-100 text-amber-900',
  'needs-work': 'bg-orange-100 text-orange-900',
  'very-low': 'bg-rose-100 text-rose-900',
};
const inputClass = 'min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const cell = 'whitespace-nowrap px-3 py-2 tabular-nums';
const muted = 'text-sm text-slate-600';
const number = (value: number | null) => value === null ? '—' : formatTrNumber(value);
const percent = (value: number) => '%' + formatTrNumber(value * 100, 1);

function ResultsTable({ label, headings, children, mobileCards = false }: {
  label: string;
  headings: string[];
  children: React.ReactNode;
  mobileCards?: boolean;
}) {
  return (
    <div className={`min-w-0 max-w-full overflow-x-auto rounded-lg border border-slate-200${mobileCards ? ' branch-ranking' : ''}`}>
      <table className="w-full text-left text-sm" aria-label={label} role="table">
        <thead className="bg-slate-100 text-slate-700" role="rowgroup">
          <tr role="row">{headings.map((heading) => <th key={heading} scope="col" role="columnheader" className={cell}>{heading}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100" role="rowgroup">{children}</tbody>
      </table>
    </div>
  );
}

function OutcomesTable({ rows }: { rows: ReturnType<typeof summarizeBranchOutcomes> }) {
  return (
    <ResultsTable label="Kazanım sonuçları" headings={['Kazanım', 'Öğrenci', 'Doğru', 'Yanlış', 'Boş', 'Başarı']}>
      {rows.map((row) => <tr key={row.title}>
        <th scope="row" className="min-w-48 px-3 py-2 font-medium">{row.title}</th>
        {[row.students, row.correct, row.incorrect, row.blank, percent(row.rate)].map((value, index) =>
          <td className={cell} key={index}>{value}</td>)}
      </tr>)}
    </ResultsTable>
  );
}

export function BranchReport({ allRows, rows }: { allRows: BranchResult[]; rows: BranchResult[] }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Sıralama');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('');
  const [selected, setSelected] = useState<BranchResult>();
  const [itemOrder, setItemOrder] = useState('question');
  const summary = useMemo(() => summarizeBranchScores(rows), [rows]);
  const overall = useMemo(() => new Map(rankBranchStudents(allRows).map(({ row, rank }) => [row, rank])), [allRows]);
  const scoped = useMemo(() => rankBranchStudents(rows), [rows]);
  const outcomes = useMemo(() => summarizeBranchOutcomes(rows), [rows]);
  const items = useMemo(() => summarizeBranchItems(rows), [rows]);
  const search = normalizeTurkish(query);
  const visible = scoped.filter(({ row }) =>
    (!search || normalizeTurkish(`${row.name} ${row.number}`).includes(search)) &&
    (!level || branchLevel(branchPercent(row)).id === level));
  const student = selected && rows.includes(selected) ? selected : undefined;
  const studentOutcomes = student ? summarizeBranchOutcomes([student]) : [];
  const studentItems = Object.entries(student?.items ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  const byDifficulty = [...items].sort((a, b) => a.difficulty - b.difficulty || a.question - b.question);
  const priority = byDifficulty.filter((item) => item.difficulty < 0.6).slice(0, 5);
  const support = scoped.filter(({ row }) => branchLevel(branchPercent(row)).needsSupport);
  const stats = [
    ['Öğrenci', rows.length], ['Ortalama net', number(summary.averageNet)],
    ['Ortalama doğru', number(summary.averageCorrect)], ['Ortalama yanlış', number(summary.averageIncorrect)],
    ['Ortalama boş', number(summary.averageBlank)],
  ];

  return (
    <div className="mt-4 space-y-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map(([label, value]) => <div className="rounded-lg bg-slate-100 px-3 py-2" key={label}>
          <dt className="text-xs text-slate-600">{label}</dt><dd className="font-bold tabular-nums">{value}</dd>
        </div>)}
      </dl>
      <dl className="grid auto-rows-fr grid-cols-4 gap-2 sm:grid-cols-5" aria-label="Net düzeylerine göre öğrenci sayısı">
        {[...BRANCH_LEVELS].reverse().map(({ id, label, range }) => (
          <div key={id} className={`col-span-2 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2 text-center last:col-start-2 sm:col-span-1 sm:last:col-start-auto ${levelColors[id]}`}>
            <dt className="text-xs font-semibold leading-tight [overflow-wrap:anywhere]">
              {label}
              <span className="mt-0.5 block font-medium">%{range}</span>
            </dt>
            <dd className="text-base font-bold leading-tight tabular-nums">{summary.levels.get(id)}</dd>
          </div>
        ))}
      </dl>
      <nav aria-label="Branş analizi görünümleri" className="grid grid-cols-3 gap-2 border-b border-slate-200 pb-2">
        {tabs.map((label) => <button type="button" key={label} aria-pressed={tab === label} onClick={() => setTab(label)}
          className={`branch-action ${tab === label ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-800'}`}>{label}</button>)}
      </nav>

      {tab === 'Sıralama' && <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm font-medium">Öğrenci ara
            <input className={inputClass} type="search" value={query} placeholder="Ad veya numara" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label className="text-sm font-medium">Net düzeyi
            <select className={inputClass} value={level} onChange={(event) => setLevel(event.target.value)}>
              <option value="">Tümü</option>
              {BRANCH_LEVELS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
        </div>
        <p className={muted}>Düzey, netin soru sayısına oranına göre belirlenir. Eksi netler Kötü düzeyine girer. Eşit netler aynı sırayı paylaşır.</p>
        {visible.length ? <ResultsTable label="Branş sıralaması" mobileCards headings={['Genel sıra', ...(rows !== allRows ? ['Sınıf sırası'] : []), 'Öğrenci', 'Sınıf', 'Soru', 'Doğru', 'Yanlış', 'Boş', 'Net', 'Düzey']}>
          {visible.map(({ row, rank }) => {
            const badge = branchLevel(branchPercent(row));
            return <tr key={`${row.number}:${row.name}:${row.classroom}`} role="row">
              <td className={cell} role="cell" data-label="Genel sıra">{overall.get(row)}</td>
              {rows !== allRows && <td className={cell} role="cell" data-label="Sınıf sırası">{rank}</td>}
              <th scope="row" className={cell} role="rowheader">
                <button className="min-h-11 max-w-full whitespace-normal text-left font-semibold text-blue-800 underline underline-offset-2 [overflow-wrap:anywhere] sm:max-w-48" type="button"
                  aria-expanded={student === row} onClick={() => setSelected(student === row ? undefined : row)}>{row.name}</button>
                {row.number && <span className="ml-2 font-normal text-slate-500">{row.number}</span>}
              </th>
              {[
                ['Sınıf', row.classroom || '—'], ['Soru', row.questionCount], ['Doğru', row.correct],
                ['Yanlış', row.incorrect], ['Boş', row.blank], ['Net', number(row.net)],
              ].map(([label, value]) => <td key={label} role="cell" data-label={String(label)} className={cell}>{value ?? '—'}</td>)}
              <td className={cell} role="cell" data-label="Düzey"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${levelColors[badge.id]}`}>{badge.label}</span></td>
            </tr>;
          })}
        </ResultsTable> : <p className={muted}>Filtreye uyan öğrenci bulunamadı.</p>}
        {student && <section aria-label="Öğrenci ayrıntısı" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <h3 className="font-bold">{student.name} · {number(student.net)} net</h3>
          <p className={muted}>{number(student.correct)} doğru · {number(student.incorrect)} yanlış · {number(student.blank)} boş</p>
          {studentItems.length > 0 && <p className={muted}>
            Yanlış sorular: {studentItems.filter(([, mark]) => mark === 'Y').map(([question]) => question).join(', ') || '—'}
            {' · '}Boş sorular: {studentItems.filter(([, mark]) => mark === 'B').map(([question]) => question).join(', ') || '—'}
          </p>}
          {studentOutcomes.length > 0 && <OutcomesTable rows={studentOutcomes} />}
        </section>}
      </div>}

      {tab === 'Eksik analizi' && <div className="space-y-3">
        <h3 className="font-bold">Desteğe ihtiyacı olan öğrenciler</h3>
        <p className={muted}>Kötü ve Geliştirilmeli düzeyindeki öğrenciler bu listede gösterilir.</p>
        {support.length ? <ResultsTable label="Destek önceliği olan öğrenciler" headings={['Öğrenci', 'Sınıf', 'Net', 'Net / soru']}>
          {support.map(({ row }) => {
            const badge = branchLevel(branchPercent(row));
            return <tr key={`${row.number}:${row.name}:${row.classroom}`}>
              <th scope="row" className={cell}>
                {row.name}
                <span className={`mt-1 block w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${levelColors[badge.id]}`}>{badge.label}</span>
              </th>
              {[row.classroom || '—', number(row.net), percent(row.net / row.questionCount)].map((value, index) =>
                <td className={cell} key={index}>{value}</td>)}
            </tr>;
          })}
        </ResultsTable> : <p className={muted}>Seçili grupta Kötü veya Geliştirilmeli düzeyinde öğrenci yok.</p>}
        <h3 className="font-bold">Kazanım eksikleri</h3>
        {outcomes.length > 0 ? <>
          <p className={muted}>Kazanımlar en düşük başarıdan en yükseğe sıralanır. Her satır, dosyada o kazanım için sonucu bulunan öğrencileri kapsar.</p>
          <OutcomesTable rows={outcomes} />
        </> : <p className={muted}>Kazanım analizi için öğrenci karnesinde kazanım sonuçları veya Excel’de soru sonuçlarıyla birlikte doldurulmuş Kazanımlar sayfası gerekir.</p>}
        <h3 className="font-bold">Tekrar önceliği olan sorular</h3>
        {priority.length > 0 ? <ul className="flex flex-wrap gap-2">
          {priority.map((item) => <li key={item.question} className="rounded-full bg-rose-100 px-3 py-1.5 text-sm text-rose-900">
            {item.question}. soru · {percent(item.difficulty)} doğru · {item.count} kayıt
          </li>)}
        </ul> : <p className={muted}>{items.length ? 'Doğru oranı %60’ın altında soru yok.' : 'Zorlanılan soruları belirlemek için soru bazında sonuç gerekli.'}</p>}
        <p className={muted}>{summary.known > 0
          ? `Doğru, yanlış ve boş ortalamaları, bu üç değeri bilinen ${summary.known} öğrenci üzerinden hesaplandı.`
          : 'Yüklenen kayıtlarda doğru, yanlış ve boş dağılımı bulunmuyor.'}</p>
      </div>}

      {tab === 'Madde analizi' && <div className="space-y-3">
        {items.length ? <>
          <label className="block max-w-xs text-sm font-medium">Madde sırası
            <select className={inputClass} value={itemOrder} onChange={(event) => setItemOrder(event.target.value)}>
              <option value="question">Soru numarası</option><option value="difficulty">En zor sorular önce</option>
            </select>
          </label>
          <p className={muted}>Güçlük, soruyu doğru yapanların oranıdır. Ayırt edicilik, sorunun sonucu ile o soru çıkarıldıktan sonraki net arasındaki ilişkidir. En az 4 tam cevap dizisi ve değişken sonuç gerekir.</p>
          <ResultsTable label="Madde analizi" headings={['Soru', 'Kayıt', 'Doğru', 'Yanlış', 'Boş', 'Güçlük', 'Ayırt edicilik', 'Tam kayıt']}>
            {(itemOrder === 'difficulty' ? byDifficulty : items).map((item) => <tr key={item.question}>
              <th scope="row" className={cell}>{item.question}</th>
              {[item.count, item.correct, item.incorrect, item.blank, percent(item.difficulty),
                number(item.discrimination), item.discriminationCount].map((value, index) => <td key={index} className={cell}>{value}</td>)}
            </tr>)}
          </ResultsTable>
        </> : <p className={muted}>Madde analizi için her öğrencinin S1, S2, … sütunlarında D (doğru), Y (yanlış) veya B (boş) bilgisi olmalıdır. Excel ya da metin tabanlı PDF kullanabilirsin.</p>}
      </div>}
    </div>
  );
}
