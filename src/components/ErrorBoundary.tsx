import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let displayMessage = error?.message || 'Beklenmeyen bir hata oluştu.';
    try {
      const parsed = JSON.parse(displayMessage) as { error?: string; operationType?: string };
      if (parsed && typeof parsed.error === 'string') {
        if (parsed.error.toLowerCase().includes('quota')) {
          displayMessage =
            'Bulut veritabanı günlük ücretsiz kullanım kotasına ulaşıldı. Kota ertesi gün sıfırlanacaktır; verileriniz cihazınızda güvenle saklanmaya devam eder.';
        } else if (parsed.error.toLowerCase().includes('permission')) {
          displayMessage =
            'Bulut veritabanı erişim izni doğrulanamadı. Lütfen Google hesabınızla yeniden oturum açın.';
        } else {
          displayMessage = parsed.error;
        }
      }
    } catch {
      // Plain error message
    }
    return { hasError: true, message: displayMessage };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, info);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] p-6">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h1 className="text-base font-bold text-slate-900">Bir Sorun Oluştu</h1>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Uygulamayı Yenile
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
