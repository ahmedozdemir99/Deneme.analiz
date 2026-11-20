import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileUp,
  GraduationCap,
  Users,
  BarChart3,
  FolderArchive,
  AlertCircle,
  Loader2,
  X,
} from 'lucide-react';
import { ExamArchiveState, ParsedExamBundle, StudentExamRecord } from './types/exam';
import { parseExamPdf } from './utils/pdfParser';
import {
  addManualExamToStudent,
  deleteExamFromState,
  EMPTY_ARCHIVE_STATE,
  loadArchiveState,
  mergeExamBundle,
  renameExamInState,
  saveArchiveState,
} from './utils/storage';
import { StudentCardsView } from './components/StudentCardsView';
import { StudentDetailView } from './components/StudentDetailView';
import { OverviewView } from './components/OverviewView';
import { ExamArchiveView } from './components/ExamArchiveView';
import { SchoolWeaknessView } from './components/SchoolWeaknessView';
import { UploadModal } from './components/UploadModal';

type NavTab = 'students' | 'overview' | 'archive' | 'weaknesses';

const BUNDLED_SAMPLE_PDF_URL =
  '/assets/aistudio/zekiayvenli-8s_n_f-i_leyenzeka-1denme-toplu_a3d32d85.pdf';
const BUNDLED_SAMPLE_FILE_NAME = 'zekiayvenli-8sınıf-işleyenzeka-1denme-toplu.pdf';

export default function App() {
  const [archive, setArchive] = useState<ExamArchiveState>(() => {
    return loadArchiveState() ?? EMPTY_ARCHIVE_STATE;
  });
  const [activeTab, setActiveTab] = useState<NavTab>('students');
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [sampleProgress, setSampleProgress] = useState<{ cur: number; total: number } | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'info' | 'error';
    text: string;
  } | null>(null);

  const persistAndSet = useCallback((next: ExamArchiveState) => {
    setArchive(next);
    const saved = saveArchiveState(next);
    if (!saved.ok && saved.error) {
      setBannerMessage({ type: 'error', text: saved.error });
    }
  }, []);

  const loadBundledSamplePdf = useCallback(async () => {
    setIsLoadingSample(true);
    setSampleProgress({ cur: 0, total: 120 });
    try {
      const res = await fetch(BUNDLED_SAMPLE_PDF_URL);
      if (!res.ok) {
        throw new Error('Örnek PDF dosyası yüklenemedi.');
      }
      const buffer = await res.arrayBuffer();
      const bundle = await parseExamPdf(buffer, BUNDLED_SAMPLE_FILE_NAME, {
        examOrder: 1,
        isSample: true,
        onProgress: (cur, total) => setSampleProgress({ cur, total }),
      });

      setArchive((prev) => {
        // Avoid duplicating the bundled exam if already present with exact same name & sample flag
        const filteredPrev = prev.exams.some((e) => e.isSample && e.name === bundle.examMeta.name)
          ? prev
          : prev;
        const alreadyLoaded = filteredPrev.exams.find(
          (e) => e.isSample && e.fileName === BUNDLED_SAMPLE_FILE_NAME
        );
        const base = alreadyLoaded ? deleteExamFromState(filteredPrev, alreadyLoaded.id) : filteredPrev;
        const { nextState } = mergeExamBundle(base, bundle);
        saveArchiveState(nextState);
        return nextState;
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Yüklü örnek PDF okunurken bir sorun oluştu.',
      });
    } finally {
      setIsLoadingSample(false);
      setSampleProgress(null);
    }
  }, []);

  // On first launch with empty archive, automatically import the user's attached PDF
  useEffect(() => {
    const existing = loadArchiveState();
    if (!existing || (existing.exams.length === 0 && existing.students.length === 0)) {
      void loadBundledSamplePdf();
    }
  }, [loadBundledSamplePdf]);

  const nextExamOrder = useMemo(() => {
    if (archive.exams.length === 0) return 1;
    return Math.max(...archive.exams.map((e) => e.examOrder)) + 1;
  }, [archive.exams]);

  const selectedStudent = useMemo(() => {
    if (!selectedStudentId) return null;
    return archive.students.find((s) => s.id === selectedStudentId) ?? null;
  }, [archive.students, selectedStudentId]);

  const handleBundlesParsed = useCallback(
    (bundles: ParsedExamBundle[]) => {
      let current = archive;
      let totalRecords = 0;
      let totalMatched = 0;
      let totalNew = 0;

      for (const b of bundles) {
        const res = mergeExamBundle(current, b);
        current = res.nextState;
        totalRecords += b.records.length;
        totalMatched += res.matchedCount;
        totalNew += res.newStudentsCount;
      }

      persistAndSet(current);
      return {
        totalRecords,
        matchedCount: totalMatched,
        newStudentsCount: totalNew,
        examCount: bundles.length,
      };
    },
    [archive, persistAndSet]
  );

  const handleDeleteExam = useCallback(
    (examId: string) => {
      const next = deleteExamFromState(archive, examId);
      persistAndSet(next);
      if (selectedStudentId && !next.students.some((s) => s.id === selectedStudentId)) {
        setSelectedStudentId(null);
      }
    },
    [archive, persistAndSet, selectedStudentId]
  );

  const handleRenameExam = useCallback(
    (examId: string, newName: string) => {
      const next = renameExamInState(archive, examId, newName);
      persistAndSet(next);
    },
    [archive, persistAndSet]
  );

  const handleAddManualExam = useCallback(
    (studentId: string, record: StudentExamRecord) => {
      const next = addManualExamToStudent(archive, studentId, record);
      persistAndSet(next);
      setBannerMessage({
        type: 'info',
        text: `"${record.examName}" denemesi öğrenci arşivine eklendi ve karşılaştırmalar güncellendi.`,
      });
    },
    [archive, persistAndSet]
  );

  const handleImportJson = useCallback(
    (imported: ExamArchiveState) => {
      persistAndSet(imported);
      setSelectedStudentId(null);
      setBannerMessage({
        type: 'info',
        text: `Yedek başarıyla yüklendi (${imported.exams.length} deneme, ${imported.students.length} öğrenci).`,
      });
    },
    [persistAndSet]
  );

  const handleSelectStudent = (studentId: string) => {
    setSelectedStudentId(studentId);
    setActiveTab('students');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'students', label: 'Öğrenci Kartları', icon: <Users className="h-4 w-4" /> },
    { id: 'overview', label: 'Genel Bakış', icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'archive', label: 'Deneme Arşivi', icon: <FolderArchive className="h-4 w-4" /> },
    { id: 'weaknesses', label: 'Eksik Analizi', icon: <AlertCircle className="h-4 w-4" /> },
  ];

  const schoolLabel = archive.exams[0]?.schoolName;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      {/* Clean 3-Zone Top Bar */}
      <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          {/* Zone 1: Brand */}
          <button
            type="button"
            onClick={() => {
              setSelectedStudentId(null);
              setActiveTab('students');
            }}
            className="flex shrink-0 items-center gap-2.5 text-left"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-700 text-white">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="font-display text-sm font-extrabold tracking-tight text-slate-900 whitespace-nowrap">
                LGS Deneme Analiz
              </div>
              <div className="hidden max-w-[200px] truncate text-[11px] font-medium text-slate-500 xl:block">
                {schoolLabel || '8. Sınıf Öğrenci Takip Arşivi'}
              </div>
            </div>
          </button>

          {/* Zone 2: Navigation */}
          <nav className="hidden items-center gap-1 md:flex" aria-label="Ana menü">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    if (item.id !== 'students') setSelectedStudentId(null);
                  }}
                  className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary CTA */}
          <button
            type="button"
            onClick={() => setIsUploadOpen(true)}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-800"
          >
            <FileUp className="h-4 w-4" />
            PDF / Excel Yükle
          </button>
        </div>

        {/* Mobile navigation row */}
        <div className="grid grid-cols-4 gap-1 border-t border-slate-100 px-2 py-2 md:hidden">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveTab(item.id);
                  if (item.id !== 'students') setSelectedStudentId(null);
                }}
                className={`flex flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[10px] font-semibold leading-tight ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {item.icon}
                <span className="truncate max-w-full">{item.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Optional Feedback Banner */}
        {bannerMessage && (
          <div
            className={`no-print mb-5 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs font-medium ${
              bannerMessage.type === 'error'
                ? 'border-red-200 bg-red-50 text-red-800'
                : 'border-blue-200 bg-blue-50 text-blue-900'
            }`}
          >
            <span>{bannerMessage.text}</span>
            <button
              type="button"
              onClick={() => setBannerMessage(null)}
              className="rounded p-1 hover:bg-black/5"
              aria-label="Bildirimi kapat"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Initial Sample PDF Parsing State */}
        {isLoadingSample && archive.students.length === 0 ? (
          <div className="mx-auto my-12 max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-700" />
            <h2 className="mt-4 text-base font-bold text-slate-900">
              Deneme Sonuç PDF&apos;i Analiz Ediliyor
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Tüm öğrencilerin ders bazlı doğru, yanlış, boş, net ve kazanım sonuçları okunuyor...
            </p>
            {sampleProgress && sampleProgress.total > 0 && (
              <div className="mt-5">
                <div className="mb-1.5 flex justify-between font-mono text-xs text-slate-600 tabular-nums">
                  <span>
                    Sayfa {sampleProgress.cur} / {sampleProgress.total}
                  </span>
                  <span>
                    %{Math.round((sampleProgress.cur / sampleProgress.total) * 100)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full bg-blue-700 transition-all duration-150"
                    style={{
                      width: `${Math.round((sampleProgress.cur / sampleProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : activeTab === 'students' && selectedStudent ? (
          <StudentDetailView
            student={selectedStudent}
            nextExamOrder={nextExamOrder}
            onBack={() => setSelectedStudentId(null)}
            onAddManualExam={handleAddManualExam}
            onOpenUpload={() => setIsUploadOpen(true)}
          />
        ) : activeTab === 'students' ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h1 className="text-xl font-extrabold text-slate-900">Öğrenci Kartları</h1>
                <p className="text-xs text-slate-500 tabular-nums">
                  {archive.students.length} öğrenci · {archive.exams.length} deneme arşivi · Kartlara tıklayarak satır satır deneme tablosu, grafikler ve eksik kazanımları inceleyin.
                </p>
              </div>
            </div>
            <StudentCardsView
              students={archive.students}
              onSelectStudent={handleSelectStudent}
              onOpenUpload={() => setIsUploadOpen(true)}
            />
          </div>
        ) : activeTab === 'overview' ? (
          <OverviewView
            state={archive}
            onSelectStudent={handleSelectStudent}
            onOpenUpload={() => setIsUploadOpen(true)}
          />
        ) : activeTab === 'archive' ? (
          <ExamArchiveView
            state={archive}
            onOpenUpload={() => setIsUploadOpen(true)}
            onDeleteExam={handleDeleteExam}
            onRenameExam={handleRenameExam}
            onImportJson={handleImportJson}
            onReloadSamplePdf={loadBundledSamplePdf}
            isLoadingSample={isLoadingSample}
          />
        ) : (
          <SchoolWeaknessView state={archive} onSelectStudent={handleSelectStudent} />
        )}
      </main>

      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onBundlesParsed={handleBundlesParsed}
        nextExamOrder={nextExamOrder}
        onReloadSamplePdf={loadBundledSamplePdf}
        isLoadingSample={isLoadingSample}
      />
    </div>
  );
}
