import type { MetadataCategory, ScrubMode, SupportedFormat } from '../core/types';

export const SCRUB_MODE_LABELS: Record<ScrubMode, string> = {
  lossless: 'Lossless',
  'oriented-srgb': 'Oriented & Scrubbed (sRGB)',
  'pdf-deep': 'Deep PDF Scrubbed',
  'already-clean': 'Already Clean',
};

export const CATEGORY_LABELS: Record<MetadataCategory, string> = {
  location: 'Location & GPS',
  device: 'Device & Camera',
  author: 'Author & Software',
  dates: 'Timestamps',
  'pdf-embedded': 'Embedded PDF Metadata',
  other: 'Other / Raw Tags',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function getCleanFilename(
  originalName: string,
  filenameMode: 'suffix' | 'original'
): string {
  if (filenameMode === 'original') {
    return originalName;
  }
  const dotIdx = originalName.lastIndexOf('.');
  if (dotIdx <= 0) {
    return `${originalName}_clean`;
  }
  return `${originalName.slice(0, dotIdx)}_clean${originalName.slice(dotIdx)}`;
}

export function mimeTypeForFormat(format: SupportedFormat): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
  }
}

export function triggerBlobDownload(bytes: Uint8Array, filename: string, mimeType: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
