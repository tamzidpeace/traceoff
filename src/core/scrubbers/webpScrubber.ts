const asciiDecoder = new TextDecoder('latin1');
const asciiEncoder = new TextEncoder();

const VP8X_FLAG_ICC = 0x20;
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Losslessly strip `EXIF`, `XMP `, and optionally `ICCP` chunks from a RIFF/WebP container,
 * clearing the corresponding `VP8X` feature flags and updating the outer RIFF size.
 */
export function scrubWebpLossless(
  bytes: Uint8Array,
  options: { preserveIcc: boolean }
): Uint8Array {
  if (
    bytes.length < 12 ||
    !startsWithAscii(bytes, 0, 'RIFF') ||
    !startsWithAscii(bytes, 8, 'WEBP')
  ) {
    throw new Error('Invalid WebP: missing RIFF/WEBP header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true);
  if (riffSize < 4 || 8 + riffSize > bytes.length) {
    throw new Error(
      `Truncated WebP: declared RIFF size (${riffSize}) is out of bounds for ${bytes.length} bytes`
    );
  }

  const containerEnd = 8 + riffSize;
  const keptChunks: Uint8Array[] = [];
  let offset = 12;

  while (offset < containerEnd) {
    if (offset + 8 > containerEnd) {
      throw new Error(`Truncated WebP: incomplete chunk header at offset ${offset}`);
    }

    const fourcc = asciiDecoder.decode(bytes.subarray(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;

    if (dataEnd > containerEnd) {
      throw new Error(
        `Truncated WebP: chunk "${fourcc}" at offset ${offset} declares size ${chunkSize} beyond RIFF bounds`
      );
    }

    const paddedSize = chunkSize + (chunkSize & 1);
    const nextOffset = dataStart + paddedSize;

    const shouldDrop =
      fourcc === 'EXIF' ||
      fourcc === 'XMP ' ||
      (fourcc === 'ICCP' && !options.preserveIcc);

    if (!shouldDrop) {
      const outChunk = new Uint8Array(8 + paddedSize);
      outChunk.set(bytes.subarray(offset, dataEnd), 0);

      if (fourcc === 'VP8X') {
        if (chunkSize < 10) {
          throw new Error(`Invalid WebP: VP8X chunk must be at least 10 bytes (got ${chunkSize})`);
        }
        const clearMask =
          VP8X_FLAG_EXIF | VP8X_FLAG_XMP | (!options.preserveIcc ? VP8X_FLAG_ICC : 0);
        outChunk[8] = (outChunk[8] ?? 0) & ~clearMask;
      }

      keptChunks.push(outChunk);
    }

    offset = nextOffset;
  }

  if (keptChunks.length === 0) {
    throw new Error('Invalid WebP: no image chunks found');
  }

  const bodySize = keptChunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(12 + bodySize);
  out.set(asciiEncoder.encode('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set(asciiEncoder.encode('WEBP'), 8);

  let writePos = 12;
  for (const chunk of keptChunks) {
    out.set(chunk, writePos);
    writePos += chunk.length;
  }

  return out;
}
