import { CheckCircle2, Lock, MapPin } from 'lucide-react';
import type { MetadataCategory, MetadataField, MetadataReport, ScrubResult } from '../core/types';
import { CATEGORY_LABELS } from '../utils/format';

export interface MetadataDrawerProps {
  before: MetadataReport;
  result: ScrubResult | null;
}

const CATEGORY_ORDER: MetadataCategory[] = [
  'location',
  'device',
  'author',
  'dates',
  'pdf-embedded',
  'other',
];

function groupFieldsByCategory(
  fields: MetadataField[]
): Array<{ category: MetadataCategory; fields: MetadataField[] }> {
  const map = new Map<MetadataCategory, MetadataField[]>();
  for (const field of fields) {
    const existing = map.get(field.category);
    if (existing) {
      existing.push(field);
    } else {
      map.set(field.category, [field]);
    }
  }
  return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
    category: cat,
    fields: map.get(cat) ?? [],
  }));
}

export function MetadataDrawer({ before, result }: MetadataDrawerProps) {
  const after = result?.after ?? null;
  const groups = groupFieldsByCategory(before.fields);
  const remainingKeySet = new Set(after ? after.fields.map((f) => f.key) : []);

  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
          {after ? 'Before vs. After Metadata Inspection' : 'Discovered Metadata Inspector'}
        </h4>

        {before.hasGps && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
            <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
            <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>Local Only — GPS coordinates are never sent to map servers</span>
          </span>
        )}
      </div>

      {before.fields.length === 0 ? (
        <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
          No metadata tags detected in this file.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map(({ category, fields }) => (
            <div
              key={category}
              className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
            >
              <div className="bg-zinc-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                {CATEGORY_LABELS[category]} ({fields.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-200 bg-zinc-50/70 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Tag</th>
                      <th className="px-3 py-1.5 font-medium">Before</th>
                      {after && <th className="px-3 py-1.5 font-medium">After</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {fields.map((field, idx) => {
                      const stillPresent = after !== null && remainingKeySet.has(field.key);
                      return (
                        <tr
                          key={`${field.key}-${idx}`}
                          className="bg-white dark:bg-zinc-900/30"
                        >
                          <td className="px-3 py-2 align-top font-medium text-zinc-800 dark:text-zinc-200">
                            <div>{field.label}</div>
                            <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                              {field.key}
                            </div>
                          </td>
                          <td
                            className={`px-3 py-2 align-top font-mono text-[11px] break-all ${
                              after && !stillPresent
                                ? 'text-zinc-400 line-through dark:text-zinc-500'
                                : field.sensitive
                                  ? 'text-red-700 dark:text-red-300'
                                  : 'text-zinc-700 dark:text-zinc-300'
                            }`}
                          >
                            {field.value}
                          </td>
                          {after && (
                            <td className="px-3 py-2 align-top">
                              {stillPresent ? (
                                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  Remaining
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                  Removed
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
