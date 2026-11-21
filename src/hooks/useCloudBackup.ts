import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  User,
} from 'firebase/auth';
import { auth, firebaseProjectId, googleProvider } from '../firebase';
import { ExamArchiveState } from '../types/exam';
import {
  CloudSyncManifest,
  loadArchiveFromCloud,
  mergeLocalAndCloudArchives,
  syncArchiveToCloud,
} from '../utils/cloudBackup';

const PENDING_EXIT_BACKUP_KEY = 'lgs_pending_cloud_backup_v1';
const LAST_CLOUD_BACKUP_AT_KEY = 'lgs_last_cloud_backup_at_v1';

export type CloudSyncStatus =
  | 'idle'
  | 'hydrating'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'error'
  | 'offline';

export interface UseCloudBackupResult {
  user: User | null;
  authReady: boolean;
  syncStatus: CloudSyncStatus;
  lastBackupAt: Date | null;
  errorMessage: string | null;
  errorCode: string | null;
  isSigningIn: boolean;
  hasPendingChanges: boolean;
  isInIframe: boolean;
  currentHostname: string;
  firebaseProjectId: string;
  signInWithGoogle: () => Promise<void>;
  signInWithGoogleRedirect: () => Promise<void>;
  backupAndSignOut: () => Promise<void>;
  backupNow: (forceFull?: boolean) => Promise<boolean>;
  restoreFromCloud: () => Promise<boolean>;
}

function extractErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/\((auth\/[a-z0-9-]+|permission-denied|unavailable|resource-exhausted)\)/i);
  if (match) return match[1];
  const bareAuth = raw.match(/(auth\/[a-z0-9-]+)/i);
  if (bareAuth) return bareAuth[1];
  return null;
}

function parseFriendlyError(error: unknown): { code: string | null; message: string } {
  const code = extractErrorCode(error);
  const raw = error instanceof Error ? error.message : String(error);
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) {
      const lower = parsed.error.toLowerCase();
      if (lower.includes('quota') || lower.includes('resource-exhausted')) {
        return {
          code: 'quota-exceeded',
          message:
            'Bulut veritabanı günlük ücretsiz kullanım kotası doldu. Kota yarın sıfırlanacaktır; verileriniz cihazınızda güvenle saklanıyor.',
        };
      }
      if (lower.includes('permission') || lower.includes('insufficient')) {
        return {
          code: 'permission-denied',
          message:
            'Bulut veritabanı erişim izni doğrulanamadı. Google hesabınızla çıkış yapıp yeniden giriş yapmayı deneyin.',
        };
      }
      if (lower.includes('offline') || lower.includes('network') || lower.includes('unavailable')) {
        return {
          code: 'network-offline',
          message:
            'İnternet bağlantısı veya bulut sunucusuna erişim kurulamadı. Bağlantı geldiğinde otomatik yedeklenecektir.',
        };
      }
      return { code, message: `Bulut hatası: ${parsed.error}` };
    }
  } catch {
    // Plain Firebase Auth / runtime error
  }

  switch (code) {
    case 'auth/unauthorized-domain':
      return {
        code,
        message: `Bu alan adı (${hostname || 'mevcut site'}) Firebase Yetkili Alan Adları listesinde kayıtlı değil. Firebase Console → Authentication → Settings → Authorized domains bölümüne "${hostname}" adresini eklemeniz gerekir.`,
      };
    case 'auth/popup-closed-by-user':
      return {
        code,
        message:
          'Google giriş penceresi tamamlanmadan kapatıldı. Mobilde/PWA kullanıyorsanız aşağıdaki "Yönlendirme ile Giriş Yap" seçeneğini deneyin.',
      };
    case 'auth/cancelled-popup-request':
      return {
        code,
        message: 'Önceki giriş isteği iptal edildi. Lütfen tekrar dokunun.',
      };
    case 'auth/popup-blocked':
      return {
        code,
        message:
          'Tarayıcı Google açılır penceresini engelledi. Açılır pencerelere izin verin veya mobil yönlendirme ile giriş yapın.',
      };
    case 'auth/operation-not-supported-in-this-environment':
    case 'auth/web-storage-unsupported':
      return {
        code,
        message:
          'Bu tarayıcı ortamı açılır pencere veya çerez depolamasını kısıtlıyor. Normal Chrome sekmesinde açarak veya yönlendirme ile giriş yaparak deneyin.',
      };
    case 'auth/network-request-failed':
      return {
        code,
        message:
          'Google oturum sunucularına bağlanılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.',
      };
    case 'auth/operation-not-allowed':
      return {
        code,
        message:
          'Firebase projesinde Google ile oturum açma sağlayıcısı etkin değil. Firebase Console → Authentication → Sign-in method bölümünden Google seçeneğini etkinleştirin.',
      };
    case 'auth/internal-error':
      return {
        code,
        message:
          'Google giriş penceresi bu cihazda başlatılamadı (auth/internal-error). "Yönlendirme ile Giriş Yap" seçeneğini deneyin veya sayfayı yenileyin.',
      };
    default:
      return {
        code,
        message: code
          ? `Google bulut bağlantısı başarısız (${code}). Lütfen tekrar deneyin.`
          : `Google bulut bağlantısı başarısız: ${raw.slice(0, 140)}`,
      };
  }
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
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const isInIframe = typeof window !== 'undefined' && window.self !== window.top;
  const currentHostname = typeof window !== 'undefined' ? window.location.hostname : '';

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

      if (syncInFlightRef.current) {
        return syncInFlightRef.current;
      }

      const task = (async (): Promise<boolean> => {
        setSyncStatus('syncing');
        setErrorMessage(null);
        setErrorCode(null);
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
          setErrorMessage(friendly.message);
          setErrorCode(friendly.code);
          setSyncStatus('error');
          markPendingFlag(true);
          if (!silent && onNotify) {
            onNotify({ type: 'error', text: friendly.message });
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
      setErrorCode(null);

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

        const cloudHadDuplicates =
          cloud.removedDuplicates > 0 ||
          cloud.archive.students.length < cloud.manifest.studentHashes.size;

        const cloudDiffersFromLocal =
          merged.exams.length !== currentLocal.exams.length ||
          merged.students.length !== currentLocal.students.length ||
          cloudHadDuplicates ||
          (cloud.exists && !localHadUniqueData);

        if (cloud.exists && cloudDiffersFromLocal) {
          suppressNextAutoSyncRef.current = true;
          archiveRef.current = merged;
          onReplaceArchive(merged);
        }

        if (cloud.lastBackupAt) {
          persistBackupTimestamp(cloud.lastBackupAt);
        }

        if (!cloud.exists || localHadUniqueData || hadPendingOfflineBackup || cloudHadDuplicates) {
          await executeBackup(false, true);
        } else {
          markPendingFlag(false);
          setSyncStatus('synced');
        }
      } catch (error) {
        const friendly = parseFriendlyError(error);
        setErrorMessage(friendly.message);
        setErrorCode(friendly.code);
        setSyncStatus('error');
      }
    },
    [executeBackup, markPendingFlag, onReplaceArchive, persistBackupTimestamp]
  );

  // Complete any pending mobile/PWA redirect sign-in on startup
  useEffect(() => {
    if (isInIframe) return;
    let active = true;
    getRedirectResult(auth)
      .then((result) => {
        if (!active || !result?.user) return;
        onNotify?.({
          type: 'info',
          text: 'Google hesabınız bağlandı. Tüm denemeleriniz otomatik olarak buluta yedeklenecektir.',
        });
      })
      .catch((error) => {
        if (!active) return;
        const friendly = parseFriendlyError(error);
        setErrorMessage(friendly.message);
        setErrorCode(friendly.code);
      });
    return () => {
      active = false;
    };
  }, [isInIframe, onNotify]);

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

  // Program Exit & App Hide Automatic Cloud Backup Listeners
  useEffect(() => {
    const flushOnExit = () => {
      if (!userRef.current) return;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
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

  const signInWithGoogleRedirect = useCallback(async () => {
    setIsSigningIn(true);
    setErrorMessage(null);
    setErrorCode(null);
    try {
      await signInWithRedirect(auth, googleProvider);
    } catch (error) {
      const friendly = parseFriendlyError(error);
      setErrorMessage(friendly.message);
      setErrorCode(friendly.code);
      onNotify?.({ type: 'error', text: friendly.message });
      setIsSigningIn(false);
    }
  }, [onNotify]);

  const signInWithGoogle = useCallback(async () => {
    setIsSigningIn(true);
    setErrorMessage(null);
    setErrorCode(null);
    try {
      await signInWithPopup(auth, googleProvider);
      onNotify?.({
        type: 'info',
        text: 'Google hesabınız bağlandı. Tüm denemeleriniz otomatik olarak buluta yedeklenecektir.',
      });
    } catch (error) {
      const code = extractErrorCode(error);
      // On standalone mobile PWA / direct browser tab (NOT inside an iframe),
      // automatically fall back to redirect flow when popup is blocked or unsupported.
      const shouldFallbackToRedirect =
        !isInIframe &&
        (code === 'auth/popup-blocked' ||
          code === 'auth/operation-not-supported-in-this-environment' ||
          code === 'auth/internal-error');

      if (shouldFallbackToRedirect) {
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectError) {
          const friendly = parseFriendlyError(redirectError);
          setErrorMessage(friendly.message);
          setErrorCode(friendly.code);
          onNotify?.({ type: 'error', text: friendly.message });
          return;
        }
      }

      const friendly = parseFriendlyError(error);
      setErrorMessage(friendly.message);
      setErrorCode(friendly.code);
      onNotify?.({ type: 'error', text: friendly.message });
    } finally {
      setIsSigningIn(false);
    }
  }, [isInIframe, onNotify]);

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
      const friendly = parseFriendlyError(error);
      onNotify?.({ type: 'error', text: friendly.message });
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
    setErrorCode(null);
    try {
      const cloud = await loadArchiveFromCloud(activeUser.uid);
      manifestRef.current = cloud.manifest;
      if (
        !cloud.exists ||
        (cloud.archive.exams.length === 0 && cloud.archive.students.length === 0)
      ) {
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
      if (cloud.removedDuplicates > 0) {
        await executeBackup(false, true);
      } else {
        markPendingFlag(false);
        setSyncStatus('synced');
      }
      onNotify?.({
        type: 'info',
        text: `Bulut yedeği geri yüklendi (${cloud.archive.exams.length} deneme, ${cloud.archive.students.length} öğrenci).`,
      });
      return true;
    } catch (error) {
      const friendly = parseFriendlyError(error);
      setErrorMessage(friendly.message);
      setErrorCode(friendly.code);
      setSyncStatus('error');
      onNotify?.({ type: 'error', text: friendly.message });
      return false;
    }
  }, [markPendingFlag, onNotify, onReplaceArchive, persistBackupTimestamp]);

  return {
    user,
    authReady,
    syncStatus,
    lastBackupAt,
    errorMessage,
    errorCode,
    isSigningIn,
    hasPendingChanges,
    isInIframe,
    currentHostname,
    firebaseProjectId,
    signInWithGoogle,
    signInWithGoogleRedirect,
    backupAndSignOut,
    backupNow,
    restoreFromCloud,
  };
}
