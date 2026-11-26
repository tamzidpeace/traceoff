import { Lock } from 'lucide-react';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-zinc-200 bg-white/60 py-6 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
      <div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-3 px-4 sm:flex-row sm:items-center sm:px-6">
        <div className="flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
          <span>
            Zero uploads · Zero analytics · Pure Web Worker binary scrubbing (MIT License)
          </span>
        </div>

        <a
          href="https://github.com/tamzidpeace/traceoff"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-zinc-700 underline decoration-zinc-400 underline-offset-4 transition hover:text-emerald-600 dark:text-zinc-300 dark:hover:text-emerald-400"
        >
          github.com/tamzidpeace/traceoff
        </a>
      </div>
    </footer>
  );
}
