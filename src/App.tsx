import React, { useCallback, useMemo, useState } from 'react';
import {
  FileUp,
  ScanLine,
  GraduationCap,
  Users,
  BarChart3,
  FolderArchive,
  AlertCircle,
  X,
  Trophy,
} from 'lucide-react';
import { ExamArchiveState, ParsedExamBundle, StudentExamRecord } from './types/exam';
import { mergeBranchBackup, readBranchExams, updateBranchExams } from './utils/branchArchive';
import type { BranchExam } from './utils/branchHistory';
import {
  addManualExamToStudent,
  deduplicateArchiveState,
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
import { BranchAnalysisView } from './components/BranchAnalysisView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { CloudBackupControl } from './components/CloudBackupControl';
import { LeaderboardView } from './components/LeaderboardView';
import { useCloudBackup } from './hooks/useCloudBackup';

const ExamScanDialog = React.lazy(() => import('./components/ExamScanDialog').then(module => ({ default: module.ExamScanDialog })));

type NavTab = 'students' | 'leaderboard' | 'overview' | 'archive' | 'weaknesses' | 'branches';

export default function App() {
  const [archive, setArchive] = useState<ExamArchiveState>(() => {
    return loadArchiveState() ?? EMPTY_ARCHIVE_STATE;
  });
  const [activeTab, setActiveTab] = useState<NavTab>('students');
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [scan, setScan] = useState({ loaded: false, open: false });

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

  const cloud = useCloudBackup(archive, persistAndSet, setBannerMessage);
  const { queueNewExams } = cloud;

  const saveNewExams = useCallback((next: ExamArchiveState) => {
    const previousIds = new Set(archive.exams.map((exam) => exam.id));
    const newIds = next.exams
      .filter((exam) => !exam.isSample && !previousIds.has(exam.id))
      .map((exam) => exam.id);
    persistAndSet(next);
    queueNewExams(next, newIds);
  }, [archive.exams, persistAndSet, queueNewExams]);

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
        totalRecords += current.exams.find((exam) => exam.id === b.examMeta.id)?.studentCount ?? 0;
        totalMatched += res.matchedCount;
        totalNew += res.newStudentsCount;
      }

      saveNewExams(current);
      return {
        totalRecords,
        matchedCount: totalMatched,
        newStudentsCount: totalNew,
        examCount: bundles.length,
      };
    },
    [archive, saveNewExams]
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
      saveNewExams(next);
      setBannerMessage({
        type: 'info',
        text: `"${record.examName}" denemesi öğrenci arşivine eklendi ve karşılaştırmalar güncellendi.`,
      });
    },
    [archive, saveNewExams]
  );

  const handleImportJson = useCallback(
    (imported: ExamArchiveState, incomingBranches?: BranchExam[]) => {
      const { state: cleaned } = deduplicateArchiveState(imported);
      const previousBranches = incomingBranches ? readBranchExams() : [];
      const merged = incomingBranches ? mergeBranchBackup(previousBranches, incomingBranches) : undefined;
      const branchesChanged = Boolean(merged && (merged.addedExams || merged.addedResults));
      if (merged && branchesChanged) {
        try {
          updateBranchExams(() => merged.exams);
        } catch {
          throw new Error('Branş kayıtları kaydedilemedi. Tarayıcının depolama alanını kontrol edin.');
        }
      }
      const saved = saveArchiveState(cleaned);
      if (!saved.ok) {
        if (branchesChanged) updateBranchExams(() => previousBranches);
        throw new Error(saved.error ?? 'Arşiv kaydedilemedi.');
      }
      setArchive(cleaned);
      setSelectedStudentId(null);
      const branchCount = merged
        ? ` Branş arşivine ${merged.addedExams} deneme ve ${merged.addedResults} öğrenci sonucu eklendi.` : '';
      setBannerMessage({
        type: 'info',
        text: `Yedek yüklendi (${cleaned.exams.length} tam LGS denemesi, ${cleaned.students.length} öğrenci).${branchCount}`,
      });
    },
    []
  );

  const handleSelectStudent = (studentId: string) => {
    setSelectedStudentId(studentId);
    setActiveTab('students');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'students', label: 'Öğrenci Kartları', icon: <Users className="h-4 w-4" /> },
    { id: 'leaderboard', label: 'Sıralama', icon: <Trophy className="h-4 w-4" /> },
    { id: 'overview', label: 'Genel Bakış', icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'archive', label: 'Deneme Arşivi', icon: <FolderArchive className="h-4 w-4" /> },
    { id: 'weaknesses', label: 'Eksik Analizi', icon: <AlertCircle className="h-4 w-4" /> },
    { id: 'branches', label: 'Branş Analizi', icon: <BarChart3 className="h-4 w-4" /> },
  ];

  const schoolLabel = archive.exams[0]?.schoolName;

  return (
    <div className={`flex min-h-screen flex-col bg-[#F8FAFC] text-[#0F172A]${activeTab === 'branches' ? ' overflow-x-clip' : ''}`}>
      {/* Clean 3-Zone Top Bar */}
      <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-6 lg:px-8">
          {/* Zone 1: Brand */}
          <button
            type="button"
            onClick={() => {
              setSelectedStudentId(null);
              setActiveTab('students');
            }}
            className="flex min-w-0 items-center gap-2 text-left sm:gap-2.5"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-700 text-white sm:size-9">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="font-display text-xs font-extrabold tracking-tight text-slate-900 sm:whitespace-nowrap sm:text-sm">
                LGS Deneme Analiz
              </div>
              <div className="hidden max-w-[200px] truncate text-[11px] font-medium text-slate-500 xl:block">
                {schoolLabel || '8. Sınıf Öğrenci Takip Arşivi'}
              </div>
            </div>
          </button>

          {/* Zone 2: Navigation */}
          <nav className="hidden items-center gap-1 xl:flex" aria-label="Ana menü">
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
                  className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-colors ${
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

          {/* Zone 3: Actions (Cloud Backup + PWA Install + Primary Upload CTA) */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <CloudBackupControl
              cloud={cloud}
              examCount={archive.exams.length}
              studentCount={archive.students.length}
            />
            <PWAInstallButton />
            <button type="button"
              onClick={() => setScan({ loaded: true, open: true })}
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-200 px-2 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-50 sm:px-3">
              <ScanLine className="size-4" />
              <span className="hidden sm:inline">Fotoğraftan PDF</span>
              <span className="sm:hidden">Tara</span>
            </button>
            <button
              type="button"
              onClick={() => setIsUploadOpen(true)}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-700 px-3 sm:gap-2 sm:px-3.5 text-xs font-semibold text-white transition-colors hover:bg-blue-800"
            >
              <FileUp className="h-4 w-4" />
              <span className="hidden sm:inline">PDF / Excel Yükle</span>
              <span className="sm:hidden">Yükle</span>
            </button>
          </div>
        </div>

        {/* Mobile navigation row */}
        <div className="mx-auto grid max-w-7xl auto-rows-fr grid-cols-3 gap-1 min-[360px]:grid-cols-6 border-t border-slate-100 px-1.5 py-2 sm:px-6 xl:hidden">
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
                className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[10px] font-semibold leading-tight sm:text-xs ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {item.icon}
                <span className="max-w-full text-center [overflow-wrap:anywhere]">{item.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
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

        {activeTab === 'branches' ? (
          <BranchAnalysisView />
        ) : activeTab === 'students' && selectedStudent ? (
          <StudentDetailView
            student={selectedStudent}
            nextExamOrder={nextExamOrder}
            onBack={() => setSelectedStudentId(null)}
            onAddManualExam={handleAddManualExam}
            onOpenUpload={() => setIsUploadOpen(true)}
          />
        ) : activeTab === 'students' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h1 className="text-xl font-extrabold text-slate-900">Öğrenci Kartları</h1>
                <p className="text-xs text-slate-500 tabular-nums">
                  Üstten deneme seçerek her sınavın öğrenci kartlarını ayrı ayrı görüntüleyin; kartlara tıklayarak satır satır arşiv ve kazanım analizine ulaşın.
                </p>
              </div>
            </div>
            <StudentCardsView
              exams={archive.exams}
              students={archive.students}
              onSelectStudent={handleSelectStudent}
              onOpenUpload={() => setIsUploadOpen(true)}
            />
          </div>
        ) : activeTab === 'leaderboard' ? (
          <LeaderboardView
            state={archive}
            onSelectStudent={handleSelectStudent}
            onOpenUpload={() => setIsUploadOpen(true)}
          />
        ) : activeTab === 'overview' ? (
          <OverviewView
            state={archive}
            onSelectStudent={handleSelectStudent}
            onOpenUpload={() => setIsUploadOpen(true)}
          />
        ) : activeTab === 'archive' ? (
          <ExamArchiveView
            state={archive}
            cloud={cloud}
            onOpenUpload={() => setIsUploadOpen(true)}
            onDeleteExam={handleDeleteExam}
            onRenameExam={handleRenameExam}
            onImportJson={handleImportJson}
          />
        ) : (
          <SchoolWeaknessView state={archive} onSelectStudent={handleSelectStudent} />
        )}
      </main>

      <footer className="mt-auto border-t border-slate-200/80 bg-white/70 py-4 text-center">
        <p className="font-mono text-xs font-medium tracking-wide text-slate-500">
          by_ahmedozdemir
        </p>
      </footer>

      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onBundlesParsed={handleBundlesParsed}
        nextExamOrder={nextExamOrder}
      />
      {scan.loaded && <React.Suspense fallback={null}>
        <ExamScanDialog open={scan.open} onClose={() => setScan({ loaded: true, open: false })} />
      </React.Suspense>}
      <OfflineIndicator />
    </div>
  );
}
