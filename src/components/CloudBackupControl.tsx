import React, { useEffect, useRef, useState } from 'react';
import {
  Cloud,
  CloudCheck,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Loader2,
  LogOut,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { UseCloudBackupResult } from '../hooks/useCloudBackup';

interface CloudBackupControlProps {
  cloud: UseCloudBackupResult;
  examCount: number;
  studentCount: number;
}

export function formatBackupTime(date: Date | null): string {
  if (!date) return 'Henüz yedeklenmedi';
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const CloudBackupControl: React.FC<CloudBackupControlProps> = ({
  cloud,
  examCount,
  studentCount,
}) => {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!cloud.authReady) {
    return null;
  }

  if (!cloud.user) {
    return (
      <button
        type="button"
        onClick={() => void cloud.signInWithGoogle()}
        disabled={cloud.isSigningIn}
        title="Google ile giriş yaparak mevcut yedeğinizi açın ve yeni denemeleri yedekleyin"
        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg sm:gap-1.5 border border-slate-300 bg-white px-2 sm:px-2.5 text-xs font-semibold text-slate-700 transition-colors hover:border-blue-400 hover:bg-blue-50/50 hover:text-blue-700 disabled:opacity-50"
      >
        {cloud.isSigningIn ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
        ) : (
          <Cloud className="h-3.5 w-3.5 text-blue-600" />
        )}
        <span className="hidden sm:inline">Bulut Yedek</span>
        <span className="sm:hidden">Bulut</span>
      </button>
    );
  }

  const isBusy = cloud.syncStatus === 'syncing' || cloud.syncStatus === 'hydrating';
  const isError = cloud.syncStatus === 'error';
  const isOffline = cloud.syncStatus === 'offline';

  return (
    <div className="sm:relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg sm:gap-1.5 border px-2 sm:px-2.5 text-xs font-semibold transition-colors ${
          isError
            ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
            : isOffline
            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : 'border-emerald-200 bg-emerald-50/70 text-emerald-800 hover:bg-emerald-100/80'
        }`}
        aria-expanded={open}
        aria-label="Bulut yedekleme menüsü"
      >
        {isBusy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
        ) : isError ? (
          <AlertCircle className="h-3.5 w-3.5 text-red-600" />
        ) : isOffline ? (
          <CloudOff className="h-3.5 w-3.5 text-amber-700" />
        ) : (
          <CloudCheck className="h-3.5 w-3.5 text-emerald-700" />
        )}
        <span className="hidden sm:inline">
          {cloud.syncStatus === 'hydrating' ? 'Yedek okunuyor' : isBusy ? 'Yedekleniyor' : isOffline ? 'Çevrimdışı' : isError ? 'Bulut Hatası' : cloud.hasPendingChanges ? 'Yedek Bekliyor' : 'Bulut Aktif'}
        </span>
      </button>

      {open && (
        <div className="absolute right-3 top-full z-50 mt-2 w-72 max-w-[calc(100vw-1.5rem)] sm:right-0 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
          <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="min-w-0">
              <div className="truncate text-xs font-bold text-slate-900">
                {cloud.user.displayName || 'Google Hesabı'}
              </div>
              <div className="truncate text-[11px] text-slate-500">{cloud.user.email}</div>
            </div>
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          </div>

          <div className="mt-3 space-y-1.5 text-[11px] text-slate-600">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Son yedekleme</span>
              <span className="font-mono font-semibold text-slate-800 tabular-nums">
                {formatBackupTime(cloud.lastBackupAt)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Cihazdaki arşiv</span>
              <span className="font-mono font-semibold text-slate-800 tabular-nums">
                {examCount} deneme · {studentCount} öğrenci
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Otomatik yedekleme</span>
              <span className="font-semibold text-emerald-700">Yeni deneme eklenince</span>
            </div>
          </div>

          {cloud.errorMessage && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
              {cloud.errorMessage}
            </div>
          )}

          <div className="mt-3.5 space-y-1.5 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => void cloud.backupNow()}
              disabled={isBusy || isOffline || !cloud.hasPendingChanges}
              className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-700 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-800 disabled:opacity-50"
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudUpload className="h-3.5 w-3.5" />
              )}
              Bekleyen Denemeleri Yedekle
            </button>

            <button
              type="button"
              onClick={() => void cloud.restoreFromCloud()}
              disabled={isBusy}
              className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <CloudDownload className="h-3.5 w-3.5" />
              Buluttan Geri Yükle
            </button>

            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                await cloud.signOutFromCloud();
              }}
              disabled={isBusy}
              className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50/70 px-3 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Çıkış Yap
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
