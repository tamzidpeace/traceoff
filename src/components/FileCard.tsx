import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Loader2,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import type { MetadataReport, ScrubOptions } from '../core/types';
import type { QueueItem } from '../hooks/useScrubQueue';
import { formatBytes, getCleanFilename, SCRUB_MODE_LABELS } from '../utils/format';
import { MetadataDrawer } from './MetadataDrawer';

export interface FileCardProps {
  item: QueueItem;
  filenameMode: ScrubOptions['filenameMode'];
  onScrub: (id: string) => void;
  onConfirmSignedScrub: (id: string) => void;
  onToggleSignedConfirmed: (id: string, confirmed: boolean) => void;
  onToggleDrawer: (id: string) => void;
  onRemove: (id: string) => void;
}

function getRiskBadge(report: MetadataReport) {
  if (report.riskLevel === 'high') {
    return {
      label: report.hasGps ? 'High Risk (GPS + Device)' : 'High Risk',
      className:
        'border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300',
    };
  }
  if (report.riskLevel === 'medium') {
    return {
      label: 'Metadata Found',
      className:
        'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
    };
  }
  return {
    label: 'Already Clean',
    className:
      'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  };
}

function summarizeCategories(report: MetadataReport): string[] {
  const summary: string[] = [];
  if (report.hasGps) summary.push('GPS');
  const deviceCount = report.fields.filter((f) => f.category === 'device').length;
  if (deviceCount > 0) summary.push(`Camera/Device (${deviceCount})`);
  const authorCount = report.fields.filter((f) => f.category === 'author').length;
  if (authorCount > 0) summary.push(`Author/Software (${authorCount})`);
  if (report.embeddedImageWithMetaCount > 0) {
    summary.push(`Embedded Images (${report.embeddedImageWithMetaCount})`);
  }
  return summary;
}

export function FileCard({
  item,
  filenameMode,
  onScrub,
  onConfirmSignedScrub,
  onToggleSignedConfirmed,
  onToggleDrawer,
  onRemove,
}: FileCardProps) {
  const report = item.report;
  const result = item.result;
  const riskBadge = report ? getRiskBadge(report) : null;
  const categoryChips = report ? summarizeCategories(report) : [];
  const cleanFilename = getCleanFilename(item.name, filenameMode);

  const savedPercent =
    result && result.originalSize > 0
      ? Math.round(((result.originalSize - result.cleanSize) / result.originalSize) * 100)
      : 0;

  return (
    <article
      data-testid={`file-card-${item.name}`}
      className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition dark:border-zinc-800 dark:bg-zinc-900/75"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          {item.previewUrl ? (
            <img
              src={item.previewUrl}
              alt={`${item.name} preview`}
              className="h-14 w-14 shrink-0 rounded-xl border border-zinc-200 object-cover dark:border-zinc-700"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              <FileText className="h-6 w-6" aria-hidden="true" />
            </div>
          )}

          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {item.name}
              </h3>

              {report && (
                <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {report.format}
                </span>
              )}

              {item.status === 'inspecting' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Inspecting...
                </span>
              )}

              {item.status === 'scrubbing' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Scrubbing locally...
                </span>
              )}

              {item.status !== 'scrubbed' && riskBadge && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${riskBadge.className}`}
                >
                  <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                  {riskBadge.label}
                </span>
              )}

              {item.status === 'scrubbed' && result && (
                <>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {result.after.totalTags === 0
                      ? 'Verified Clean: 0 tracking tags remaining'
                      : `${result.after.totalTags} tags remaining`}
                  </span>
                  <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 font-mono text-[11px] font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                    {SCRUB_MODE_LABELS[result.mode]}
                  </span>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {result ? (
                <span>
                  {formatBytes(result.originalSize)} → {formatBytes(result.cleanSize)}
                  {savedPercent > 0 ? ` (-${savedPercent}%)` : ''}
                </span>
              ) : (
                <span>{formatBytes(item.size)}</span>
              )}

              {report && item.status !== 'scrubbed' && (
                <span>
                  {report.totalTags} tracking {report.totalTags === 1 ? 'tag' : 'tags'}
                </span>
              )}

              {report &&
                item.status !== 'scrubbed' &&
                categoryChips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300"
                  >
                    {chip}
                  </span>
                ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {report && (
            <button
              type="button"
              onClick={() => onToggleDrawer(item.id)}
              aria-expanded={item.drawerOpen}
              className="inline-flex items-center gap-1 rounded-xl border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <span>{item.drawerOpen ? 'Hide Metadata' : 'Inspect Metadata'}</span>
              {item.drawerOpen ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          )}

          {item.status === 'ready' && (!report?.isSignedPdf || item.signedConfirmed) && (
            <button
              type="button"
              onClick={() => onScrub(item.id)}
              className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Scrub</span>
            </button>
          )}

          {item.status === 'scrubbed' && item.cleanUrl && (
            <a
              href={item.cleanUrl}
              download={cleanFilename}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download Clean File</span>
            </a>
          )}

          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label={`Remove ${item.name}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 transition hover:bg-red-50 hover:text-red-600 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {report?.isSignedPdf && item.status !== 'scrubbed' && item.status !== 'error' && (
        <div
          role="alert"
          className="mt-3 flex flex-col gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:text-amber-200"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              <span>
                Digitally signed PDF — scrubbing alters bytes and invalidates cryptographic
                signatures.
              </span>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={item.signedConfirmed}
                disabled={item.status === 'scrubbing'}
                onChange={(e) => onToggleSignedConfirmed(item.id, e.target.checked)}
                className="h-3.5 w-3.5 rounded border-amber-500/50 text-amber-600 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span>I understand scrubbing will invalidate the digital signature</span>
            </label>
          </div>

          <button
            type="button"
            disabled={item.status === 'scrubbing'}
            onClick={() => onConfirmSignedScrub(item.id)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>Confirm &amp; Scrub Signed PDF</span>
          </button>
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          {result.warnings.map((warning, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      {item.status === 'error' && item.error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{item.error}</span>
        </div>
      )}

      {item.drawerOpen && report && <MetadataDrawer before={report} result={result} />}
    </article>
  );
}
