import { Archive, ShieldAlert, Sparkles, Trash2 } from 'lucide-react';
import type { ScrubOptions } from '../core/types';
import { formatBytes } from '../utils/format';

export interface OptionsBarProps {
  options: ScrubOptions;
  onChangeOptions: (next: ScrubOptions) => void;
  totalCount: number;
  readyCount: number;
  scrubbingCount: number;
  scrubbedCount: number;
  savedBytes: number;
  onScrubAll: () => void;
  onDownloadAllZip: () => void;
  onClearAll: () => void;
}

export function OptionsBar({
  options,
  onChangeOptions,
  totalCount,
  readyCount,
  scrubbingCount,
  scrubbedCount,
  savedBytes,
  onScrubAll,
  onDownloadAllZip,
  onClearAll,
}: OptionsBarProps) {
  return (
    <section
      aria-label="Scrubbing options and batch actions"
      className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={options.preserveIcc}
              onChange={(e) =>
                onChangeOptions({ ...options, preserveIcc: e.target.checked })
              }
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
            <span>Preserve Color Profile (ICC)</span>
          </label>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={options.autoFixOrientation}
              onChange={(e) =>
                onChangeOptions({ ...options, autoFixOrientation: e.target.checked })
              }
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
            <span>Auto-Fix Photo Orientation</span>
          </label>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">
            <span>Output Filename:</span>
            <select
              value={options.filenameMode}
              onChange={(e) =>
                onChangeOptions({
                  ...options,
                  filenameMode: e.target.value === 'original' ? 'original' : 'suffix',
                })
              }
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            >
              <option value="suffix">Append _clean</option>
              <option value="original">Keep original</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {totalCount > 0 && (
            <span className="mr-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {scrubbedCount}/{totalCount} clean
              {savedBytes > 0 ? ` · -${formatBytes(savedBytes)}` : ''}
            </span>
          )}

          <button
            type="button"
            onClick={onScrubAll}
            disabled={readyCount === 0 || scrubbingCount > 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{scrubbingCount > 0 ? 'Processing...' : 'Scrub All Files'}</span>
          </button>

          <button
            type="button"
            onClick={onDownloadAllZip}
            disabled={scrubbedCount < 2}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-300 bg-zinc-50 px-3.5 py-2 text-xs font-semibold text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            <Archive className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Download All (.zip)</span>
          </button>

          <button
            type="button"
            onClick={onClearAll}
            disabled={totalCount === 0}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-red-900/60 dark:hover:bg-red-950/40 dark:hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear All</span>
          </button>
        </div>
      </div>

      {!options.autoFixOrientation && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Auto-Fix Photo Orientation is OFF: rotated phone JPEGs will stay lossless &amp;
            ICC-preserved, but may appear rotated in viewers without EXIF orientation.
          </span>
        </p>
      )}
    </section>
  );
}
