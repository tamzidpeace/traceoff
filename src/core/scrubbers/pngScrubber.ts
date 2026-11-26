const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const STRIPPED_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const asciiDecoder = new TextDecoder('latin1');

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Losslessly strip metadata chunks (`eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`, and
 * optionally `iCCP`) from a PNG while keeping `IHDR`, `IDAT`, `IEND`, and rendering chunks byte-identical.
 */
export function scrubPngLossless(
  bytes: Uint8Array,
  options: { preserveIcc: boolean }
): Uint8Array {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('Invalid PNG: missing 8-byte PNG signature');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keptChunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let hasIhdr = false;
  let hasIend = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`Truncated PNG: incomplete chunk header at offset ${offset}`);
    }

    const dataLen = view.getUint32(offset, false);
    const chunkEnd = offset + 12 + dataLen;
    if (chunkEnd > bytes.length) {
      throw new Error(
        `Truncated PNG: chunk at offset ${offset} declares length ${dataLen} beyond file bounds (${bytes.length})`
      );
    }

    const type = asciiDecoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && type !== 'IHDR') {
      throw new Error(`Invalid PNG: first chunk must be IHDR (got "${type}")`);
    }
    if (type === 'IHDR') {
      hasIhdr = true;
    }

    const shouldStrip =
      STRIPPED_PNG_CHUNKS.has(type) || (type === 'iCCP' && !options.preserveIcc);

    if (!shouldStrip) {
      keptChunks.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (type === 'IEND') {
      hasIend = true;
      break;
    }
  }

  if (!hasIhdr) {
    throw new Error('Invalid PNG: missing IHDR chunk');
  }
  if (!hasIend) {
    throw new Error('Truncated PNG: missing IEND chunk');
  }

  return concatChunks(keptChunks);
}
