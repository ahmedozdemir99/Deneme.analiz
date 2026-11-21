import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { ExamArchiveState } from '../types/exam';
import {
  CloudSyncManifest,
  loadArchiveFromCloud,
  mergeLocalAndCloudArchives,
  syncArchiveToCloud,
} from '../utils/cloudBackup';

const PENDING_EXIT_BACKUP_KEY = 'lgs_pending_cloud_backup_v1';
const LAST_CLOUD_BACKUP_AT_KEY = 'lgs_last_cloud_backup_at_v1';

export type CloudSyncStatus = 'idle' | 'hydrating' | 'syncing' | 'synced' | 'pending' | 'error' | 'offline';

export interface UseCloudBackupResult {
  user: User | null;
  authReady: boolean;
  syncStatus: CloudSyncStatus;
  lastBackupAt: Date | null;
  errorMessage: string | null;
  isSigningIn: boolean;
  hasPendingChanges: boolean;
  signInWithGoogle: () => Promise<void>;
  backupAndSignOut: () => Promise<void>;
  backupNow: (forceFull?: boolean) => Promise<boolean>;
  restoreFromCloud: () => Promise<boolean>;
}

function parseFriendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) {
      const lower = parsed.error.toLowerCase();
      if (lower.includes('quota')) {
        return 'Bulut günlük ücretsiz kullanım kotası doldu. Kota yarın sıfırlanacaktır; verileriniz cihazınızda saklanıyor.';
      }
      if (lower.includes('permission')) {
        return 'Bulut erişim izni doğrulanamadı. Lütfen Google hesabınızla tekrar giriş yapın.';
      }
      if (lower.includes('offline') || lower.includes('network')) {
        return 'İnternet bağlantısı yok. Bağlantı kurulduğunda otomatik yedeklenecektir.';
      }
      return parsed.error;
    }
  } catch {
    // Plain error
  }
  if (raw.includes('auth/popup-closed-by-user')) {
    return 'Google oturum açma penceresi kapatıldı.';
  }
  if (raw.includes('auth/popup-blocked')) {
    return 'Tarayıcı açılır pencereyi engelledi. Lütfen açılır pencerelere izin verip tekrar deneyin.';
  }
  return 'Bulut yedekleme sırasında bir hata oluştu. Tekrar deneyebilirsiniz.';
}

export function useCloudBackup(
  archive: ExamArchiveState,
  onReplaceArchive: (next: ExamArchiveState) => void,
  onNotify?: (msg: { type: 'info' | 'error'; text: string }) => void
): UseCloudBackupResult {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus>(() =>
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'idle'
  );
  const [lastBackupAt, setLastBackupAt] = useState<Date | null>(() => {
    try {
      const saved = localStorage.getItem(LAST_CLOUD_BACKUP_AT_KEY);
      return saved ? new Date(saved) : null;
    } catch {
      return null;
    }
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const archiveRef = useRef<ExamArchiveState>(archive);
  const userRef = useRef<User | null>(user);
  const manifestRef = useRef<CloudSyncManifest | null>(null);
  const hydratedUidRef = useRef<string | null>(null);
  const syncInFlightRef = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<number | null>(null);
  const suppressNextAutoSyncRef = useRef<boolean>(false);

  archiveRef.current = archive;
  userRef.current = user;

  const markPendingFlag = useCallback((pending: boolean) => {
    dirtyRef.current = pending;
    setHasPendingChanges(pending);
    try {
      if (pending) {
        localStorage.setItem(PENDING_EXIT_BACKUP_KEY, '1');
      } else {
        localStorage.removeItem(PENDING_EXIT_BACKUP_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const persistBackupTimestamp = useCallback((date: Date) => {
    setLastBackupAt(date);
    try {
      localStorage.setItem(LAST_CLOUD_BACKUP_AT_KEY, date.toISOString());
    } catch {
      // ignore
    }
  }, []);

  const executeBackup = useCallback(
    async (forceFull = false, silent = false): Promise<boolean> => {
      const activeUser = userRef.current;
      if (!activeUser) return false;

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        markPendingFlag(true);
        setSyncStatus('offline');
        return false;
      }

      // Deduplicate concurrent sync calls
      if (syncInFlightRef.current) {
        return syncInFlightRef.current;
      }

      const task = (async (): Promise<boolean> => {
        setSyncStatus('syncing');
        setErrorMessage(null);
        try {
          const result = await syncArchiveToCloud(
            activeUser.uid,
            activeUser.displayName || activeUser.email || 'Öğretmen',
            archiveRef.current,
            manifestRef.current,
            { forceFull }
          );
          manifestRef.current = result.manifest;
          persistBackupTimestamp(result.syncedAt);
          markPendingFlag(false);
          setSyncStatus('synced');
          if (!silent && onNotify) {
            onNotify({
              type: 'info',
              text: `Tüm deneme ve öğrenci sonuçları buluta yedeklendi (${archiveRef.current.exams.length} deneme, ${archiveRef.current.students.length} öğrenci).`,
            });
          }
          return true;
        } catch (error) {
          const friendly = parseFriendlyError(error);
          setErrorMessage(friendly);
          setSyncStatus('error');
          markPendingFlag(true);
          if (!silent && onNotify) {
            onNotify({ type: 'error', text: friendly });
          }
          return false;
        } finally {
          syncInFlightRef.current = null;
        }
      })();

      syncInFlightRef.current = task;
      return task;
    },
    [markPendingFlag, onNotify, persistBackupTimestamp]
  );

  // Hydrate cloud archive on sign-in
  const hydrateForUser = useCallback(
    async (signedInUser: User) => {
      if (hydratedUidRef.current === signedInUser.uid) return;
      hydratedUidRef.current = signedInUser.uid;
      setSyncStatus('hydrating');
      setErrorMessage(null);

      try {
        const cloud = await loadArchiveFromCloud(signedInUser.uid);
        manifestRef.current = cloud.manifest;

        const hadPendingOfflineBackup = (() => {
          try {
            return localStorage.getItem(PENDING_EXIT_BACKUP_KEY) === '1';
          } catch {
            return false;
          }
        })();

        const currentLocal = archiveRef.current;
        const { merged, localHadUniqueData } = mergeLocalAndCloudArchives(
          currentLocal,
          cloud.archive
        );

        const cloudDiffersFromLocal =
          merged.exams.length !== currentLocal.exams.length ||
          merged.students.length !== currentLocal.students.length ||
          (cloud.exists && !localHadUniqueData);

        if (cloud.exists && cloudDiffersFromLocal) {
          suppressNextAutoSyncRef.current = true;
          archiveRef.current = merged;
          onReplaceArchive(merged);
        }

        if (cloud.lastBackupAt) {
          persistBackupTimestamp(cloud.lastBackupAt);
        }

        if (!cloud.exists || localHadUniqueData || hadPendingOfflineBackup) {
          // Immediately back up unified archive to cloud
          await executeBackup(false, true);
        } else {
          markPendingFlag(false);
          setSyncStatus('synced');
        }
      } catch (error) {
        const friendly = parseFriendlyError(error);
        setErrorMessage(friendly);
        setSyncStatus('error');
      }
    },
    [executeBackup, markPendingFlag, onReplaceArchive, persistBackupTimestamp]
  );

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      userRef.current = nextUser;
      setAuthReady(true);

      if (nextUser) {
        void hydrateForUser(nextUser);
      } else {
        hydratedUidRef.current = null;
        manifestRef.current = null;
        setSyncStatus('idle');
        setErrorMessage(null);
      }
    });
    return unsubscribe;
  }, [hydrateForUser]);

  // Auto-backup whenever archive changes while authenticated (debounced 1.2s)
  useEffect(() => {
    if (!authReady || !user) return;
    if (hydratedUidRef.current !== user.uid) return;

    if (suppressNextAutoSyncRef.current) {
      suppressNextAutoSyncRef.current = false;
      return;
    }

    markPendingFlag(true);
    setSyncStatus((prev) => (prev === 'offline' ? 'offline' : 'pending'));

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void executeBackup(false, true);
    }, 1200);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [archive, authReady, user, executeBackup, markPendingFlag]);

  // CRITICAL: Program Exit & App Hide Automatic Cloud Backup Listeners
  // Flushes pending changes immediately on tab hide (Android Chrome / PWA exit), pagehide, and beforeunload
  useEffect(() => {
    const flushOnExit = () => {
      if (!userRef.current) return;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      // Always perform a fast diff-sync on exit (zero redundant writes if already clean, immediate commit if anything changed)
      void executeBackup(false, true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushOnExit();
      }
    };

    const handlePageHide = () => {
      flushOnExit();
    };

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!userRef.current) return;
      if (dirtyRef.current || syncInFlightRef.current) {
        flushOnExit();
        e.preventDefault();
        e.returnValue = '';
      }
    };

    const handleOnline = () => {
      if (userRef.current) {
        void executeBackup(false, true);
      } else {
        setSyncStatus('idle');
      }
    };

    const handleOffline = () => {
      setSyncStatus('offline');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [executeBackup]);

  const signInWithGoogle = useCallback(async () => {
    setIsSigningIn(true);
    setErrorMessage(null);
    try {
      await signInWithPopup(auth, googleProvider);
      onNotify?.({
        type: 'info',
        text: 'Google hesabınız bağlandı. Tüm denemeleriniz otomatik olarak buluta yedeklenecektir.',
      });
    } catch (error) {
      const friendly = parseFriendlyError(error);
      setErrorMessage(friendly);
      onNotify?.({ type: 'error', text: friendly });
    } finally {
      setIsSigningIn(false);
    }
  }, [onNotify]);

  const backupAndSignOut = useCallback(async () => {
    if (!userRef.current) return;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const ok = await executeBackup(false, true);
    try {
      await signOut(auth);
      onNotify?.({
        type: 'info',
        text: ok
          ? 'Tüm verileriniz buluta yedeklendi ve güvenli çıkış yapıldı.'
          : 'Oturum kapatıldı. Yerel verileriniz cihazınızda korunuyor.',
      });
    } catch (error) {
      onNotify?.({ type: 'error', text: parseFriendlyError(error) });
    }
  }, [executeBackup, onNotify]);

  const backupNow = useCallback(
    async (forceFull = false) => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return executeBackup(forceFull, false);
    },
    [executeBackup]
  );

  const restoreFromCloud = useCallback(async (): Promise<boolean> => {
    const activeUser = userRef.current;
    if (!activeUser) return false;
    setSyncStatus('hydrating');
    setErrorMessage(null);
    try {
      const cloud = await loadArchiveFromCloud(activeUser.uid);
      manifestRef.current = cloud.manifest;
      if (!cloud.exists || (cloud.archive.exams.length === 0 && cloud.archive.students.length === 0)) {
        setSyncStatus('synced');
        onNotify?.({
          type: 'info',
          text: 'Bulut hesabınızda henüz kayıtlı yedek bulunmuyor.',
        });
        return false;
      }
      suppressNextAutoSyncRef.current = true;
      archiveRef.current = cloud.archive;
      onReplaceArchive(cloud.archive);
      if (cloud.lastBackupAt) {
        persistBackupTimestamp(cloud.lastBackupAt);
      }
      markPendingFlag(false);
      setSyncStatus('synced');
      onNotify?.({
        type: 'info',
        text: `Bulut yedeği geri yüklendi (${cloud.archive.exams.length} deneme, ${cloud.archive.students.length} öğrenci).`,
      });
      return true;
    } catch (error) {
      const friendly = parseFriendlyError(error);
      setErrorMessage(friendly);
      setSyncStatus('error');
      onNotify?.({ type: 'error', text: friendly });
      return false;
    }
  }, [markPendingFlag, onNotify, onReplaceArchive, persistBackupTimestamp]);

  return {
    user,
    authReady,
    syncStatus,
    lastBackupAt,
    errorMessage,
    isSigningIn,
    hasPendingChanges,
    signInWithGoogle,
    backupAndSignOut,
    backupNow,
    restoreFromCloud,
  };
}
