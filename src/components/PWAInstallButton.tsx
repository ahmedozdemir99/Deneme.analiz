import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg sm:gap-1.5 border border-slate-300 bg-white px-2 sm:px-3 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50"
        title="Uygulamayı cihazınıza kurun"
      >
        <Download className="h-3.5 w-3.5 text-blue-700" />
        <span className="hidden sm:inline">Uygulamayı Kur</span>
        <span className="sm:hidden">Kur</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg sm:gap-1.5 border border-slate-300 bg-white px-2 sm:px-2.5 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50"
          title="Ana Ekrana Ekle"
        >
          <Smartphone className="h-3.5 w-3.5 text-blue-700" />
          <span className="hidden sm:inline">Ana Ekrana Ekle</span>
          <span className="sm:hidden">Kur</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[2px]"
            role="dialog"
            aria-modal="true"
          >
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-bold text-slate-900">
                  iPhone / iPad Ana Ekrana Ekle
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Kapat"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-slate-600">
                <li>
                  1. Safari alt çubuğundaki <strong>Paylaş</strong> simgesine dokunun.
                </li>
                <li>
                  2. Açılan menüde aşağı kaydırıp <strong>Ana Ekrana Ekle</strong> seçeneğine dokunun.
                </li>
                <li>
                  3. Sağ üstten <strong>Ekle</strong> butonuna basarak kurulumu tamamlayın.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-slate-900 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Anladım
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="no-print fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 shadow-md">
      <WifiOff className="h-3.5 w-3.5 text-amber-700" />
      <span>Çevrimdışı Mod — Kayıtlı verilerinizle çalışmaya devam edebilirsiniz.</span>
    </div>
  );
};
