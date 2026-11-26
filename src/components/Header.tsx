import { Moon, ShieldCheck, Sun, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface HeaderProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export function Header({ isDark, onToggleTheme }: HeaderProps) {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/90">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                TraceOff
              </h1>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                JPEG · PNG · WebP · PDF
              </span>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Client-side lossless metadata inspector &amp; scrubber
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="status"
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300"
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>100% Local Processing — Files never leave your browser</span>
          </div>

          <div
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              isOnline
                ? 'border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
            title={
              isOnline
                ? 'Offline-ready PWA: works even if you disconnect'
                : 'Browser is offline — scrubbing continues locally'
            }
          >
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
            )}
            <span>{isOnline ? 'Offline Ready' : 'Offline Mode'}</span>
          </div>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {isDark ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
