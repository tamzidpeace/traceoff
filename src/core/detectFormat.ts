import type { SupportedFormat } from './types';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const PDF_HEADER_SCAN_LIMIT = 1024;

function matchesBytesAt(
  bytes: Uint8Array,
  offset: number,
  pattern: readonly number[]
): boolean {
  if (offset < 0 || offset + pattern.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Detect a supported file format strictly from leading magic bytes.
 * Returns null for unsupported or truncated inputs.
 */
export function detectFormat(bytes: Uint8Array): SupportedFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }

  if (matchesBytesAt(bytes, 0, PNG_MAGIC)) {
    return 'png';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // 'R'
    bytes[1] === 0x49 && // 'I'
    bytes[2] === 0x46 && // 'F'
    bytes[3] === 0x46 && // 'F'
    bytes[8] === 0x57 && // 'W'
    bytes[9] === 0x45 && // 'E'
    bytes[10] === 0x42 && // 'B'
    bytes[11] === 0x50 // 'P'
  ) {
    return 'webp';
  }

  const scanLimit = Math.min(bytes.length, PDF_HEADER_SCAN_LIMIT);
  for (let offset = 0; offset <= scanLimit - PDF_MAGIC.length; offset++) {
    if (matchesBytesAt(bytes, offset, PDF_MAGIC)) {
      return 'pdf';
    }
  }

  return null;
}
