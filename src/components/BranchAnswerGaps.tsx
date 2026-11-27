import { useMemo, useState } from 'react';
import { formatTrNumber } from '../utils/analytics';
import type { BranchResult } from '../utils/branchAnalysis';
import { summarizeBranchAnswerGaps } from '../utils/branchStatistics';

const categories = [
  { key: 'correct', label: 'Doğru', color: 'bg-emerald-600', text: 'text-emerald-800' },
  { key: 'incorrect', label: 'Yanlış', color: 'bg-rose-600', text: 'text-rose-800' },
  { key: 'blank', label: 'Boş', color: 'bg-amber-500', text: 'text-amber-900' },
] as const;

type Counts = ReturnType<typeof summarizeBranchAnswerGaps>['overall'];

function AnswerBar({ title, counts }: { title: string; counts: Counts }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title}</h4>
      <div className="flex h-4 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        {categories.map(({ key, color }) =>
          <div key={key} className={color} style={{ width: `${counts[key] / counts.total * 100}%` }} />)}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
        {categories.map(({ key, label, color, text }) => <li key={key} className={`flex items-center gap-1 ${text}`}>
          <span aria-hidden="true" className={`size-2 rounded-full ${color}`} />
          {label} {counts[key]} · %{formatTrNumber(counts[key] / counts.total * 100, 1)}
        </li>)}
      </ul>
    </div>
  );
}

export function BranchAnswerGaps({ rows }: { rows: BranchResult[] }) {
  const { overall, classrooms, students } = useMemo(() => summarizeBranchAnswerGaps(rows), [rows]);
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-labelledby="branch-answer-gaps-title" className="space-y-4 rounded-xl border border-slate-200 p-3 sm:p-4">
      <h3 id="branch-answer-gaps-title" className="font-bold">Genel eksik analizi</h3>
      {overall.count === 0 ? <p className="text-sm text-slate-600">Doğru, yanlış ve boş toplamları bulunan öğrenci kaydı yok.</p> : <>
        <p className="text-sm text-slate-600">
          {overall.count} öğrencinin {overall.total} kayıtlı soru sonucunda
          {' '}<strong>{overall.incorrect} yanlış</strong> ve <strong>{overall.blank} boş</strong> var.
          {overall.incorrect > overall.blank ? ' Yanlış cevaplar daha fazla.'
            : overall.blank > overall.incorrect ? ' Boş bırakılan sorular daha fazla.' : ''}
          {overall.count < rows.length ? ` Toplamları eksik olan ${rows.length - overall.count} öğrenci grafiğe dahil edilmedi.` : ''}
        </p>
        <AnswerBar title="Seçili grubun cevap dağılımı" counts={overall} />
        {classrooms.length > 1 && <div className="space-y-3">
          <h4 className="text-sm font-bold">Sınıflara göre dağılım</h4>
          {classrooms.map(([classroom, counts]) => <AnswerBar key={classroom}
            title={`${classroom || 'Sınıfı belirtilmemiş'} · ${counts.count} öğrenci`} counts={counts} />)}
        </div>}
        <div className="space-y-3">
          <h4 className="text-sm font-bold">Öğrencilere göre dağılım</h4>
          <p className="text-xs text-slate-600">Yanlış ve boş toplamının kayıtlı sorulara oranı en yüksek olanlar önce gösterilir.</p>
          {(expanded ? students : students.slice(0, 6)).map(({ row, counts }) =>
            <AnswerBar key={`${row.number}:${row.name}:${row.classroom}`}
              title={`${row.name}${row.classroom ? ` · ${row.classroom}` : ''}`} counts={counts} />)}
          {students.length > 6 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
            className="min-h-10 text-sm font-semibold text-blue-800 underline underline-offset-2">
            {expanded ? 'İlk 6 öğrenciyi göster' : `Tüm ${students.length} öğrenciyi göster`}
          </button>}
        </div>
      </>}
    </section>
  );
}
