import { useState } from 'react';
import { removeBranchStudent, updateBranchExams } from '../utils/branchArchive';
import { branchStudentId, type BranchExam } from '../utils/branchHistory';

type Pending = { type: 'exam' } | { type: 'student'; id: string; name: string; allExams: boolean };
const danger = 'branch-action border-red-200 text-red-800 hover:bg-red-50';

export function BranchArchiveControls({ exam, uid, onChange }: { exam: BranchExam; uid?: string; onChange: (exams: BranchExam[]) => void }) {
  const [studentId, setStudentId] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const student = exam.results.find((row) => branchStudentId(row) === studentId);

  const ask = (target: Pending) => {
    setPending(target);
    setMessage('');
    setError('');
  };

  return (
    <details className="mt-4 rounded-lg border border-slate-200 p-3">
      <summary className="min-h-11 cursor-pointer rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold">Branş arşivini yönet</summary>
      <p className="mt-1 text-sm text-slate-600">Branş kayıtlarını Deneme Arşivi’ndeki JSON Yedek düğmesiyle yedekleyebilirsin.</p>
      <div className="mt-3 space-y-3">
        {exam.results.length > 0 &&
          <label className="block max-w-md text-sm font-medium">Öğrenci sonucu
            <select value={student ? studentId : ''} onChange={(event) => {
              setStudentId(event.target.value);
              setPending(null);
            }} className="mt-1 block min-h-11 w-full min-w-0 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="">Öğrenci seç</option>
              {exam.results.map((row) => {
                const id = branchStudentId(row);
                return <option key={id} value={id}>{row.name}{row.number ? ` · ${row.number}` : ''}{row.classroom ? ` · ${row.classroom}` : ''}</option>;
              })}
            </select>
          </label>}
        <div className={`grid auto-rows-fr gap-2${exam.results.length > 0 ? ' sm:grid-cols-3' : ' sm:max-w-xs'}`}>
          {exam.results.length > 0 && <>
            <button type="button" className={danger} disabled={!student} onClick={() => {
              if (student) ask({ type: 'student', id: studentId, name: student.name, allExams: false });
            }}>Bu denemeden sil</button>
            <button type="button" className={danger} disabled={!student} onClick={() => {
              if (student) ask({ type: 'student', id: studentId, name: student.name, allExams: true });
            }}>Öğrenciyi tüm branş denemelerinden sil</button>
          </>}
          <button type="button" className={danger} onClick={() => ask({ type: 'exam' })}>Bu branş denemesini sil</button>
        </div>
        {pending && <div className="space-y-2 rounded-lg bg-red-50 p-3">
          <p className="text-sm font-medium text-red-950">
            {pending.type === 'exam' ? `“${exam.name}” denemesi ve içindeki ${exam.results.length} öğrenci sonucu silinsin mi?`
              : pending.allExams ? `${pending.name} adlı öğrencinin tüm branş sonuçları silinsin mi?`
              : `${pending.name} adlı öğrencinin “${exam.name}” sonucu silinsin mi?`}
          </p>
          <div className="grid max-w-md grid-cols-2 gap-2">
            <button type="button" className="branch-action bg-red-700 text-white hover:bg-red-800" onClick={() => {
              try {
                const next = updateBranchExams((exams) => pending.type === 'exam'
                  ? exams.filter((item) => item.id !== exam.id)
                  : removeBranchStudent(exams, pending.id, pending.allExams ? undefined : exam.id), uid);
                onChange(next);
                setStudentId('');
                setPending(null);
                setMessage('Kayıt silindi.');
                setError('');
              } catch {
                setError('Kayıt silinemedi. Tarayıcı depolama alanını kontrol edin.');
              }
            }}>Silmeyi onayla</button>
            <button type="button" className="branch-action border-slate-300 bg-white hover:bg-slate-50" onClick={() => setPending(null)}>Vazgeç</button>
          </div>
        </div>}
        {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
        {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      </div>
    </details>
  );
}
