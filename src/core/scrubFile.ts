import { detectFormat } from './detectFormat';
import { inspectImage } from './inspector/inspectImage';
import { inspectPdf } from './inspector/inspectPdf';
import { bakeOrientedImageCanvas } from './scrubbers/canvasFallback';
import { scrubJpegLossless } from './scrubbers/jpegScrubber';
import { scrubPdfDeep } from './scrubbers/pdfScrubber';
import { scrubPngLossless } from './scrubbers/pngScrubber';
import { scrubWebpLossless } from './scrubbers/webpScrubber';
import type {
  MetadataReport,
  ScrubOptions,
  ScrubResult,
  SupportedFormat,
} from './types';

export const ORIENTED_ICC_WARNING =
  'ICC color profile was converted to sRGB while baking EXIF orientation into pixel order.';

/**
 * Thrown when input bytes do not match any supported format (JPEG, PNG, WebP, or PDF).
 */
export class UnsupportedFormatError extends Error {
  readonly code = 'unsupported-format' as const;

  constructor(
    message = 'Unsupported or unrecognized file format. Please use a valid JPEG, PNG, WebP, or PDF file.'
  ) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

async function inspectByFormat(
  bytes: Uint8Array,
  format: SupportedFormat
): Promise<MetadataReport> {
  if (format === 'pdf') {
    return inspectPdf(bytes);
  }
  return inspectImage(bytes, format);
}

/**
 * Detect format from magic bytes and return a normalized MetadataReport.
 */
export async function inspectFile(bytes: Uint8Array): Promise<MetadataReport> {
  const format = detectFormat(bytes);
  if (!format) {
    throw new UnsupportedFormatError();
  }
  return inspectByFormat(bytes, format);
}

/**
 * Determine whether a file requires EXIF orientation baking via Canvas.
 */
export function needsOrientationBaking(
  before: MetadataReport,
  options: ScrubOptions
): boolean {
  return (
    before.format === 'jpeg' &&
    before.orientation !== null &&
    before.orientation >= 2 &&
    before.orientation <= 8 &&
    options.autoFixOrientation
  );
}

/**
 * Bake EXIF orientation into pixel order via Canvas and re-inspect the output.
 */
export async function completeOrientedJpegScrub(
  bytes: Uint8Array,
  before: MetadataReport,
  options: ScrubOptions
): Promise<ScrubResult> {
  const cleanBytes = await bakeOrientedImageCanvas(bytes, 'image/jpeg');
  const after = await inspectImage(cleanBytes, 'jpeg');
  const warnings: string[] = [];

  if (before.hasIccProfile && options.preserveIcc) {
    warnings.push(ORIENTED_ICC_WARNING);
  }

  return {
    format: 'jpeg',
    cleanBytes,
    mode: 'oriented-srgb',
    before,
    after,
    originalSize: bytes.byteLength,
    cleanSize: cleanBytes.byteLength,
    warnings,
  };
}

/**
 * Scrub a file using a pre-computed inspection report.
 */
export async function scrubFileWithReport(
  bytes: Uint8Array,
  before: MetadataReport,
  options: ScrubOptions
): Promise<ScrubResult> {
  const originalSize = bytes.byteLength;

  if (needsOrientationBaking(before, options)) {
    return completeOrientedJpegScrub(bytes, before, options);
  }

  if (before.totalTags === 0 && (options.preserveIcc || !before.hasIccProfile)) {
    return {
      format: before.format,
      cleanBytes: bytes,
      mode: 'already-clean',
      before,
      after: before,
      originalSize,
      cleanSize: originalSize,
      warnings: [],
    };
  }

  if (before.format === 'pdf') {
    const { cleanBytes, warnings } = await scrubPdfDeep(bytes, {
      preserveIcc: options.preserveIcc,
      allowSignedPdfScrub: options.allowSignedPdfScrub,
    });
    const after = await inspectPdf(cleanBytes);
    return {
      format: 'pdf',
      cleanBytes,
      mode: 'pdf-deep',
      before,
      after,
      originalSize,
      cleanSize: cleanBytes.byteLength,
      warnings,
    };
  }

  let cleanBytes: Uint8Array;
  switch (before.format) {
    case 'jpeg':
      cleanBytes = scrubJpegLossless(bytes, { preserveIcc: options.preserveIcc });
      break;
    case 'png':
      cleanBytes = scrubPngLossless(bytes, { preserveIcc: options.preserveIcc });
      break;
    case 'webp':
      cleanBytes = scrubWebpLossless(bytes, { preserveIcc: options.preserveIcc });
      break;
  }

  const after = await inspectImage(cleanBytes, before.format);
  return {
    format: before.format,
    cleanBytes,
    mode: 'lossless',
    before,
    after,
    originalSize,
    cleanSize: cleanBytes.byteLength,
    warnings: [],
  };
}

/**
 * Unified pipeline: detect format, inspect before-state, scrub metadata, and re-inspect after-state.
 */
export async function scrubFile(
  bytes: Uint8Array,
  options: ScrubOptions
): Promise<ScrubResult> {
  const before = await inspectFile(bytes);
  return scrubFileWithReport(bytes, before, options);
}
