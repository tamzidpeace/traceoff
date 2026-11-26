function startsWithAscii(
  bytes: Uint8Array,
  start: number,
  end: number,
  prefix: string
): boolean {
  if (end - start < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[start + i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

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

function findEoiAfterScan(bytes: Uint8Array, scanStart: number): number {
  let pos = scanStart;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }

    while (pos < bytes.length && bytes[pos] === 0xff) {
      pos++;
    }
    if (pos >= bytes.length) {
      break;
    }

    const marker = bytes[pos]!;
    pos++;

    // Stuffed 0xFF (0xFF00), TEM (0xFF01), and RST0-RST7 (0xFFD0-0xFFD7) occur inside scan data
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (marker === 0xd9) {
      return pos;
    }

    // Progressive / multi-scan JPEGs can contain intermediate table or SOS segments before EOI
    if (pos + 2 > bytes.length) {
      throw new Error(
        `Truncated JPEG: incomplete marker 0x${marker.toString(16)} segment inside scan`
      );
    }
    const segLen = (bytes[pos]! << 8) | bytes[pos + 1]!;
    if (segLen < 2 || pos + segLen > bytes.length) {
      throw new Error(
        `Truncated JPEG: invalid segment length ${segLen} for marker 0x${marker.toString(16)} inside scan`
      );
    }
    pos += segLen;
  }

  throw new Error('Truncated JPEG: missing EOI marker (0xFF 0xD9)');
}

function shouldKeepPreSosSegment(
  bytes: Uint8Array,
  marker: number,
  payloadStart: number,
  segEnd: number,
  preserveIcc: boolean
): boolean {
  // Core frame, Huffman, quantization, arithmetic, DNL, DRI, DHP, EXP markers
  if ((marker >= 0xc0 && marker <= 0xcf) || (marker >= 0xdb && marker <= 0xdf)) {
    return true;
  }
  // APP0 (JFIF/JFXX) and APP14 (Adobe color transform)
  if (marker === 0xe0 || marker === 0xee) {
    return true;
  }
  // APP2 ICC_PROFILE\0 only when preserveIcc is enabled (strips FlashPix/MPF APP2)
  if (
    marker === 0xe2 &&
    preserveIcc &&
    startsWithAscii(bytes, payloadStart, segEnd, 'ICC_PROFILE\0')
  ) {
    return true;
  }
  return false;
}

/**
 * Losslessly strip metadata segments (EXIF, XMP, IPTC, COM, non-ICC APPn)
 * from a JPEG while preserving image frames, tables, and the SOS..EOI entropy stream byte-for-byte.
 */
export function scrubJpegLossless(
  bytes: Uint8Array,
  options: { preserveIcc: boolean }
): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Invalid JPEG: missing SOI marker (0xFF 0xD8)');
  }

  const keptChunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let foundSos = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error(`Invalid JPEG: expected 0xFF marker prefix at offset ${offset}`);
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset++;
    }
    if (offset >= bytes.length) {
      throw new Error('Truncated JPEG: unexpected end of file after 0xFF marker');
    }

    const marker = bytes[offset]!;
    offset++;

    // Standalone markers with no length field (TEM, RST0..RST7)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keptChunks.push(new Uint8Array([0xff, marker]));
      continue;
    }

    if (marker === 0xd8) {
      throw new Error('Invalid JPEG: unexpected SOI marker inside stream');
    }
    if (marker === 0xd9) {
      throw new Error('Invalid JPEG: missing SOS marker (0xFF 0xDA) before EOI');
    }
    if (marker === 0x00) {
      throw new Error(`Invalid JPEG: unexpected stuffed 0xFF00 byte before SOS at offset ${offset - 2}`);
    }

    const segStart = offset - 2;
    if (offset + 2 > bytes.length) {
      throw new Error(
        `Truncated JPEG: missing segment length for marker 0x${marker.toString(16)} at offset ${segStart}`
      );
    }

    const segLen = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segLen < 2 || offset + segLen > bytes.length) {
      throw new Error(
        `Truncated JPEG: segment 0x${marker.toString(16)} at offset ${segStart} has invalid length ${segLen}`
      );
    }

    const payloadStart = offset + 2;
    const segEnd = offset + segLen;

    if (marker === 0xda) {
      const eoiEnd = findEoiAfterScan(bytes, segEnd);
      keptChunks.push(bytes.subarray(segStart, eoiEnd));
      foundSos = true;
      break;
    }

    if (shouldKeepPreSosSegment(bytes, marker, payloadStart, segEnd, options.preserveIcc)) {
      keptChunks.push(bytes.subarray(segStart, segEnd));
    }

    offset = segEnd;
  }

  if (!foundSos) {
    throw new Error('Invalid JPEG: missing SOS marker (0xFF 0xDA)');
  }

  return concatChunks(keptChunks);
}
