import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { SUBJECT_LIST, SUBJECT_MAP, type SubjectKey } from '../types/exam';
import { formatTrNumber } from '../utils/analytics';
import { branchHistoryChange, branchHistoryStudents, branchStudentHistory, branchSubjectAverages, type BranchExam } from '../utils/branchHistory';

const field = 'mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const panel = 'space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5';
const dateLabel = (date: string) => date.split('-').reverse().join('.');
const netLabel = (value: number | null) => value === null ? '—' : formatTrNumber(value);
const signed = (value: number) => (value > 0 ? '+' : '') + formatTrNumber(value);

export function BranchHistory({ exams, filter, onFilterChange }: {
  exams: BranchExam[];
  filter: SubjectKey | 'all';
  onFilterChange: (value: SubjectKey | 'all') => void;
}) {
  const [preferredStudent, setPreferredStudent] = useState('');
  const [preferredSubject, setPreferredSubject] = useState<SubjectKey>();
  const [selectedPoint, setSelectedPoint] = useState('');
  const subjects = useMemo(() => SUBJECT_LIST.filter(({ key }) => exams.some((exam) => exam.subject === key)), [exams]);
  const students = useMemo(() => branchHistoryStudents(exams), [exams]);
  const student = students.find(([id]) => id === preferredStudent) ?? students[0];
  const studentId = student?.[0] ?? '';
  const histories = useMemo(() => new Map(subjects.map(({ key }) =>
    [key, branchStudentHistory(exams, key, studentId)])), [exams, subjects, studentId]);
  const studentSubjects = subjects.filter(({ key }) => (histories.get(key)?.length ?? 0) > 0);
  const timelineSubject = filter !== 'all' ? filter
    : studentSubjects.find(({ key }) => key === preferredSubject)?.key ?? studentSubjects[0]?.key ?? subjects[0]?.key;
  const history = timelineSubject ? histories.get(timelineSubject) ?? [] : [];
  const change = branchHistoryChange(history);
  const averages = useMemo(() => branchSubjectAverages(exams, filter, studentId), [exams, filter, studentId]);
  const active = history.find(({ id }) => id === selectedPoint) ?? history.at(-1);
  const byId = new Map(history.map((point) => [point.id, point]));
  const subjectName = timelineSubject ? SUBJECT_MAP[timelineSubject].label : '';

  return (
    <section className={panel} aria-labelledby="branch-history-title">
      <h2 id="branch-history-title" className="text-lg font-bold text-slate-900">İlk ve son deneme arasındaki net değişimi</h2>
      <div className="rounded-lg bg-slate-100 p-3">
        {student && <p className="text-sm font-semibold">{student[1].name} · {subjectName}</p>}
        {change ? <>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${change.difference > 0 ? 'text-emerald-800' : change.difference < 0 ? 'text-rose-800' : 'text-slate-900'}`}>
            {change.percent === null ? 'Yüzde hesaplanamıyor' : `${signed(change.percent)}%`}
          </p>
          <p className="mt-1 text-sm text-slate-700">
            İlk: {netLabel(change.first.net)} net ({dateLabel(change.first.date)}) · Son: {netLabel(change.last.net)} net ({dateLabel(change.last.date)}) · Fark: {signed(change.difference)} net
          </p>
          <p className="mt-1 text-xs text-slate-600">{change.percent === null
            ? 'İlk deneme neti 0 olduğu için net farkı gösteriliyor.'
            : 'Yüzde, net farkının ilk deneme netinin mutlak değerine oranıdır.'}</p>
        </> : <p className="mt-1 text-sm text-slate-600">Net değişimini görmek için aynı branşta tarihli en az iki öğrenci sonucu gerekir.</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold">Ders filtresi
          <select className={field} value={filter} onChange={(event) => onFilterChange(event.target.value as SubjectKey | 'all')}>
            <option value="all">Tüm dersler</option>
            {subjects.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">Öğrenci
          <select className={field} value={studentId} onChange={(event) => setPreferredStudent(event.target.value)}>
            {students.map(([id, row]) => <option key={id} value={id}>
              {row.name}{row.number ? ` · ${row.number}` : ''}{row.classroom ? ` · ${row.classroom}` : ''}
            </option>)}
          </select>
        </label>
      </div>

      <div className="space-y-3 border-t border-slate-200 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="font-bold">Denemelere göre net gelişimi</h3>
          {filter === 'all' && studentSubjects.length > 1 && <label className="text-sm font-semibold">Grafikteki ders
            <select className={field} value={timelineSubject} onChange={(event) => setPreferredSubject(event.target.value as SubjectKey)}>
              {studentSubjects.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>}
        </div>
        {active ? <>
          <div className="h-60 w-full min-w-0" aria-label={`${subjectName} net gelişimi çizgi grafiği`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 12, right: 16, bottom: 8, left: 0 }} accessibilityLayer>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="id" tickFormatter={(id) => dateLabel(byId.get(id)?.date ?? '')} minTickGap={18} tick={{ fontSize: 11 }} />
                <YAxis width={40} domain={['auto', 'auto']} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(id) => { const point = byId.get(String(id)); return point ? `${dateLabel(point.date)} · ${point.name}` : ''; }}
                  formatter={(value) => [netLabel(typeof value === 'number' ? value : null), 'Net']}
                />
                <ReferenceLine x={active.id} stroke="#94a3b8" strokeDasharray="4 4" />
                <Line type="linear" dataKey="net" stroke="#1d4ed8" strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <label className="block max-w-lg text-sm font-semibold">Grafikteki deneme
            <select className={field} value={active.id} onChange={(event) => setSelectedPoint(event.target.value)}>
              {history.map((point) => <option key={point.id} value={point.id}>{dateLabel(point.date)} · {point.name} · {netLabel(point.net)} net</option>)}
            </select>
          </label>
        </> : <p className="text-sm text-slate-600">Bu öğrenci ve ders için tarihli branş denemesi bulunamadı.</p>}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4">
        <h3 className="font-bold">Ders ortalamaları</h3>
        <p className="text-sm text-slate-600">Grup ortalaması ilgili dersin arşivdeki tüm öğrenci sonuçlarını kapsar. Derslerin soru sayıları farklı olabilir.</p>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-slate-700"><tr>
              {['Ders', 'Deneme', 'Grup ortalaması', 'Öğrenci ortalaması'].map((label) =>
                <th key={label} scope="col" className="px-3 py-2">{label}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {averages.map((item) => <tr key={item.key}>
                <th scope="row" className="px-3 py-2 font-medium">{item.label}</th>
                <td className="px-3 py-2">{item.examCount || '—'}</td>
                <td className="px-3 py-2 tabular-nums" title={`${item.groupCount} sonuç`}>{netLabel(item.groupAverage)}</td>
                <td className="px-3 py-2 tabular-nums" title={`${item.studentCount} sonuç`}>{netLabel(item.studentAverage)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
