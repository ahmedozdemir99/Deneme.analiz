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
  backupFullArchiveToCloud,
  loadArchiveFromCloud,
  mergeLocalAndCloudArchives,
} from '../utils/cloudBackup';

const PENDING_EXAMS_KEY = 'lgs_pending_cloud_exams_v2';
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
  signOutFromCloud: () => Promise<void>;
  queueNewExams: (next: ExamArchiveState, examIds: string[]) => void;
  backupNow: () => Promise<boolean>;
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
            'İnternet bağlantısı veya bulut sunucusuna erişim kurulamadı. Bağlantı geldiğinde yedeklemeyi yeniden deneyebilirsiniz.',
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
  const hydratedUidRef = useRef<string | null>(null);
  const hydrationRef = useRef<Promise<boolean> | null>(null);
  const syncInFlightRef = useRef<Promise<boolean> | null>(null);
  const pendingExamIdsRef = useRef(new Set<string>());

  archiveRef.current = archive;

  const persistPendingExams = useCallback((uid: string) => {
    const ids = [...pendingExamIdsRef.current];
    setHasPendingChanges(ids.length > 0);
    try {
      localStorage.setItem(`${PENDING_EXAMS_KEY}:${uid}`, JSON.stringify(ids));
    } catch {
      // Pending exams can still be retried during this session.
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

  const backupNow = useCallback(async (): Promise<boolean> => {
    const activeUser = userRef.current;
    if (!activeUser) return false;
    if (syncInFlightRef.current) return syncInFlightRef.current;
    if (!navigator.onLine) {
      setSyncStatus('offline');
      return false;
    }

    const task = (async () => {
      if (userRef.current?.uid !== activeUser.uid) return false;
      setSyncStatus('syncing');
      setErrorMessage(null);
      setErrorCode(null);
      try {
        const timestamp = await backupFullArchiveToCloud(
          activeUser.uid,
          activeUser.displayName || activeUser.email || 'Öğretmen',
          archiveRef.current
        );
        if (userRef.current?.uid !== activeUser.uid) return false;
        pendingExamIdsRef.current.clear();
        persistPendingExams(activeUser.uid);
        persistBackupTimestamp(timestamp);
        setSyncStatus('synced');
        return true;
      } catch (error) {
        if (userRef.current?.uid !== activeUser.uid) return false;
        const friendly = parseFriendlyError(error);
        setErrorMessage(friendly.message);
        setErrorCode(friendly.code);
        setSyncStatus('error');
        return false;
      }
    })();
    syncInFlightRef.current = task;
    try {
      return await task;
    } finally {
      syncInFlightRef.current = null;
    }
  }, [persistBackupTimestamp, persistPendingExams]);

  const queueNewExams = useCallback((next: ExamArchiveState, examIds: string[]) => {
    const activeUser = userRef.current;
    if (!activeUser || examIds.length === 0) return;
    archiveRef.current = next;
    for (const id of examIds) pendingExamIdsRef.current.add(id);
    persistPendingExams(activeUser.uid);
    // Manual-only mode: never write to cloud until the user clicks backup.
  }, [persistPendingExams]);

  const readCloudArchive = useCallback(async (activeUser: User, restore = false): Promise<boolean> => {
    setSyncStatus('hydrating');
    setErrorMessage(null);
    setErrorCode(null);
    try {
      const cloud = await loadArchiveFromCloud(activeUser.uid);
      if (userRef.current?.uid !== activeUser.uid) return false;
      if (cloud.exists && (cloud.archive.exams.length > 0 || cloud.archive.students.length > 0)) {
        const local = archiveRef.current;
        const pending = pendingExamIdsRef.current;
        const localToMerge = restore
          ? { ...local, exams: local.exams.filter((exam) => pending.has(exam.id)) }
          : local;
        const { merged } = mergeLocalAndCloudArchives(localToMerge, cloud.archive, pending);
        archiveRef.current = merged;
        onReplaceArchive(merged);
        if (restore) {
          onNotify?.({ type: 'info', text: 'Bulut yedeği geri yüklendi.' });
        }
      } else if (restore) {
        onNotify?.({ type: 'info', text: 'Bulut hesabınızda henüz kayıtlı yedek bulunmuyor.' });
      }
      if (cloud.lastBackupAt) persistBackupTimestamp(cloud.lastBackupAt);
      setSyncStatus(pendingExamIdsRef.current.size > 0 ? 'pending' : cloud.exists ? 'synced' : 'idle');
      return cloud.exists;
    } catch (error) {
      if (userRef.current?.uid !== activeUser.uid) return false;
      const friendly = parseFriendlyError(error);
      setErrorMessage(friendly.message);
      setErrorCode(friendly.code);
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      return false;
    }
  }, [onNotify, onReplaceArchive, persistBackupTimestamp]);

  // Complete any pending mobile/PWA redirect sign-in on startup
  useEffect(() => {
    if (isInIframe) return;
    let active = true;
    getRedirectResult(auth)
      .then((result) => {
        if (!active || !result?.user) return;
        onNotify?.({
          type: 'info',
          text: 'Google hesabınız bağlandı. Buluta yalnızca Yedekle düğmesine bastığınızda veri gönderilir.',
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

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      userRef.current = nextUser;
      setAuthReady(true);
      const uid = nextUser?.uid ?? null;
      if (hydratedUidRef.current === uid) return;
      hydratedUidRef.current = uid;
      pendingExamIdsRef.current = new Set();
      setHasPendingChanges(false);
      if (!nextUser) {
        hydrationRef.current = null;
        setSyncStatus('idle');
        return;
      }

      try {
        const ids: unknown = JSON.parse(localStorage.getItem(`${PENDING_EXAMS_KEY}:${uid}`) ?? '[]');
        if (Array.isArray(ids)) {
          pendingExamIdsRef.current = new Set(ids.filter((id): id is string => typeof id === 'string'));
          setHasPendingChanges(pendingExamIdsRef.current.size > 0);
        }
      } catch {
        // Invalid local backup metadata does not affect the archive.
      }
      // Manual-only mode: signing in must not read or merge cloud data.
      hydrationRef.current = null;
      setSyncStatus(pendingExamIdsRef.current.size > 0 ? 'pending' : 'idle');
    });
  }, [readCloudArchive]);

  useEffect(() => {
    const handleOffline = () => setSyncStatus('offline');
    const handleOnline = () => {
      setSyncStatus((status) => status === 'offline'
        ? pendingExamIdsRef.current.size > 0 ? 'pending' : 'idle'
        : status);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

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
        text: 'Google hesabınız bağlandı. Buluta yalnızca Yedekle düğmesine bastığınızda veri gönderilir.',
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

  const signOutFromCloud = useCallback(async () => {
    if (!userRef.current || syncInFlightRef.current) return;
    try {
      await signOut(auth);
      onNotify?.({ type: 'info', text: 'Oturum kapatıldı. Yerel verileriniz cihazınızda korunuyor.' });
    } catch (error) {
      const friendly = parseFriendlyError(error);
      onNotify?.({ type: 'error', text: friendly.message });
    }
  }, [onNotify]);

  const restoreFromCloud = useCallback(async (): Promise<boolean> => {
    const activeUser = userRef.current;
    if (!activeUser || syncInFlightRef.current) return false;
    return readCloudArchive(activeUser, true);
  }, [readCloudArchive]);

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
    signOutFromCloud,
    queueNewExams,
    backupNow,
    restoreFromCloud,
  };
}
