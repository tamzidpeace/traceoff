import { zipSync } from 'fflate';

export interface ZipArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

function splitName(rawName: string): { dir: string; stem: string; ext: string } {
  const trimmed = rawName.trim() || 'file';
  const slashIdx = trimmed.lastIndexOf('/');
  const dir = slashIdx >= 0 ? trimmed.slice(0, slashIdx + 1) : '';
  const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  const effectiveBase = base || 'file';

  const dotIdx = effectiveBase.lastIndexOf('.');
  const hasExtension = dotIdx > 0;
  return {
    dir,
    stem: hasExtension ? effectiveBase.slice(0, dotIdx) : effectiveBase,
    ext: hasExtension ? effectiveBase.slice(dotIdx) : '',
  };
}

function allocateUniqueName(rawName: string, usedNames: Set<string>): string {
  const { dir, stem, ext } = splitName(rawName);
  const initial = `${dir}${stem}${ext}`;
  if (!usedNames.has(initial.toLowerCase())) {
    usedNames.add(initial.toLowerCase());
    return initial;
  }

  let counter = 1;
  while (true) {
    const candidate = `${dir}${stem} (${counter})${ext}`;
    if (!usedNames.has(candidate.toLowerCase())) {
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }
    counter++;
  }
}

/**
 * Bundle multiple scrubbed files into a single ZIP archive with collision-safe
 * `(1)`, `(2)`, ... filename deduplication.
 */
export function buildZipArchive(entries: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const usedNames = new Set<string>();
  const archiveMap: Record<string, Uint8Array> = {};

  for (const entry of entries) {
    const uniqueName = allocateUniqueName(entry.name, usedNames);
    archiveMap[uniqueName] = entry.bytes;
  }

  return zipSync(archiveMap);
}
