import exifr from 'exifr';
import { unzlibSync } from 'fflate';
import type { MetadataField, MetadataReport } from '../types';
import {
  classifyMetadataKey,
  computeRiskLevel,
  deduplicateFields,
  extractXmpFields,
  formatMetadataValue,
  formatTagLabel,
  hasGpsField,
} from './shared';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const latin1Decoder = new TextDecoder('latin1');

const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  xmp: true,
  iptc: true,
  icc: true,
  ifd0: {},
  ihdr: false,
  jfif: false,
  mergeOutput: false,
};

const ORIENTATION_LABEL_TO_CODE: Record<string, number> = {
  'Horizontal (normal)': 1,
  'Mirror horizontal': 2,
  'Rotate 180': 3,
  'Mirror vertical': 4,
  'Mirror horizontal and rotate 270 CW': 5,
  'Rotate 90 CW': 6,
  'Mirror horizontal and rotate 90 CW': 7,
  'Rotate 270 CW': 8,
};

function parseExifOrientation(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 8) {
    return raw;
  }
  if (typeof raw === 'string') {
    if (raw in ORIENTATION_LABEL_TO_CODE) {
      return ORIENTATION_LABEL_TO_CODE[raw] ?? null;
    }
    const num = Number(raw);
    if (Number.isInteger(num) && num >= 1 && num <= 8) {
      return num;
    }
  }
  return null;
}

const POINTER_KEYS = new Set(['ExifOffset', 'GPSInfo', 'InteropOffset']);

const TIFF_GROUPS = ['ifd0', 'ifd1', 'exif', 'gps', 'interop', 'iptc'] as const;

function extractExifrFields(
  parsed: Record<string, unknown> | undefined
): {
  fields: MetadataField[];
  hasGps: boolean;
  orientation: number | null;
  hasIccProfile: boolean;
} {
  const fields: MetadataField[] = [];
  let hasGps = false;
  let orientation: number | null = null;
  let hasIccProfile = false;

  if (!parsed || typeof parsed !== 'object') {
    return { fields, hasGps, orientation, hasIccProfile };
  }

  if (parsed.icc && typeof parsed.icc === 'object' && Object.keys(parsed.icc).length > 0) {
    hasIccProfile = true;
  }

  const ifd0 = parsed.ifd0 as Record<string, unknown> | undefined;
  if (ifd0 && ifd0.Orientation !== undefined) {
    orientation = parseExifOrientation(ifd0.Orientation);
  }

  const gpsGroup = parsed.gps as Record<string, unknown> | undefined;
  if (gpsGroup && typeof gpsGroup === 'object') {
    if (
      typeof gpsGroup.latitude === 'number' ||
      typeof gpsGroup.longitude === 'number' ||
      gpsGroup.GPSLatitude !== undefined ||
      gpsGroup.GPSLongitude !== undefined
    ) {
      hasGps = true;
    }
  }

  for (const groupName of TIFF_GROUPS) {
    const group = parsed[groupName] as Record<string, unknown> | undefined;
    if (!group || typeof group !== 'object') continue;

    for (const [key, rawValue] of Object.entries(group)) {
      if (POINTER_KEYS.has(key)) continue;
      const formatted = formatMetadataValue(rawValue);
      if (!formatted) continue;

      if (groupName === 'gps') {
        fields.push({
          key,
          label: formatTagLabel(key),
          value: formatted,
          category: 'location',
          sensitive: true,
        });
        continue;
      }

      const { category, sensitive } = classifyMetadataKey(key);
      fields.push({
        key,
        label: formatTagLabel(key),
        value: formatted,
        category,
        sensitive,
      });
    }
  }

  // Handle XMP output from exifr (can be raw XML string or parsed object)
  if (parsed.xmp !== undefined) {
    if (typeof parsed.xmp === 'string') {
      fields.push(...extractXmpFields(parsed.xmp));
    } else if (typeof parsed.xmp === 'object' && parsed.xmp !== null) {
      for (const [key, rawValue] of Object.entries(parsed.xmp as Record<string, unknown>)) {
        const formatted = formatMetadataValue(rawValue);
        if (!formatted) continue;
        const { category, sensitive } = classifyMetadataKey(key);
        fields.push({
          key: `xmp:${key}`,
          label: `XMP ${formatTagLabel(key)}`,
          value: formatted,
          category,
          sensitive,
        });
      }
    }
  }

  return { fields, hasGps, orientation, hasIccProfile };
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function scanJpegMarkersFallback(bytes: Uint8Array): {
  fields: MetadataField[];
  hasIccProfile: boolean;
} {
  const fields: MetadataField[] = [];
  let hasIccProfile = false;

  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { fields, hasIccProfile };
  }

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) break;

    // Skip fill 0xFF bytes
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset++;
    }
    if (offset >= bytes.length) break;

    const marker = bytes[offset] ?? 0;
    offset++;

    // Standalone markers (SOI/EOI/RSTn/TEM)
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // EOI or SOS (entropy stream follows SOS)
      break;
    }

    if (offset + 1 >= bytes.length) break;
    const segLen = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (segLen < 2 || offset + segLen > bytes.length) break;

    const payloadStart = offset + 2;
    const payloadEnd = offset + segLen;
    const payload = bytes.subarray(payloadStart, payloadEnd);

    if (marker === 0xe2 && startsWithAscii(payload, 0, 'ICC_PROFILE\0')) {
      hasIccProfile = true;
    } else if (marker === 0xe1 && startsWithAscii(payload, 0, 'http://ns.adobe.com/xap/1.0/\0')) {
      const xml = utf8Decoder.decode(payload.subarray(29)).replace(/\0+$/, '');
      fields.push(...extractXmpFields(xml));
    } else if (marker === 0xfe) {
      const comment = utf8Decoder.decode(payload).replace(/\0+$/, '').trim();
      if (comment) {
        fields.push({
          key: 'Comment',
          label: 'JPEG Comment',
          value: comment,
          category: 'other',
          sensitive: true,
        });
      }
    }

    offset = payloadEnd;
  }

  return { fields, hasIccProfile };
}

function findZeroByte(bytes: Uint8Array, start: number): number {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

async function parseRawExifChunk(
  payload: Uint8Array,
  fallbackKey: string
): Promise<{
  fields: MetadataField[];
  hasGps: boolean;
  orientation: number | null;
}> {
  const tiffSlice = startsWithAscii(payload, 0, 'Exif\0\0')
    ? payload.subarray(6)
    : payload;
  try {
    const parsed = (await exifr.parse(tiffSlice, EXIFR_OPTIONS)) as
      | Record<string, unknown>
      | undefined;
    const extracted = extractExifrFields(parsed);
    if (extracted.fields.length > 0) {
      return {
        fields: extracted.fields,
        hasGps: extracted.hasGps,
        orientation: extracted.orientation,
      };
    }
  } catch {
    // Fall through to raw chunk fallback below
  }

  return {
    fields: [
      {
        key: fallbackKey,
        label: 'Raw EXIF Chunk',
        value: `${payload.length} bytes`,
        category: 'other',
        sensitive: true,
      },
    ],
    hasGps: false,
    orientation: null,
  };
}

async function scanPngChunksFallback(bytes: Uint8Array): Promise<{
  fields: MetadataField[];
  hasGps: boolean;
  orientation: number | null;
  hasIccProfile: boolean;
}> {
  const fields: MetadataField[] = [];
  let hasGps = false;
  let orientation: number | null = null;
  let hasIccProfile = false;

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) {
    return { fields, hasGps, orientation, hasIccProfile };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = latin1Decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'iCCP') {
      hasIccProfile = true;
    } else if (type === 'eXIf') {
      const exifParsed = await parseRawExifChunk(data, 'eXIf');
      fields.push(...exifParsed.fields);
      hasGps = hasGps || exifParsed.hasGps;
      if (orientation === null && exifParsed.orientation !== null) {
        orientation = exifParsed.orientation;
      }
    } else if (type === 'tEXt') {
      const nul = findZeroByte(data, 0);
      if (nul > 0) {
        const key = latin1Decoder.decode(data.subarray(0, nul));
        const val = latin1Decoder.decode(data.subarray(nul + 1)).trim();
        if (val) {
          const { category, sensitive } = classifyMetadataKey(key);
          fields.push({
            key,
            label: formatTagLabel(key),
            value: val,
            category,
            sensitive,
          });
        }
      }
    } else if (type === 'zTXt') {
      const nul = findZeroByte(data, 0);
      if (nul > 0 && nul + 2 <= data.length) {
        const key = latin1Decoder.decode(data.subarray(0, nul));
        const compMethod = data[nul + 1];
        let val = '';
        if (compMethod === 0) {
          try {
            val = latin1Decoder.decode(unzlibSync(data.subarray(nul + 2))).trim();
          } catch {
            val = `<compressed zTXt ${data.length - nul - 2} bytes>`;
          }
        }
        if (val) {
          const { category, sensitive } = classifyMetadataKey(key);
          fields.push({
            key,
            label: formatTagLabel(key),
            value: val,
            category,
            sensitive,
          });
        }
      }
    } else if (type === 'iTXt') {
      const nul1 = findZeroByte(data, 0);
      if (nul1 > 0 && nul1 + 3 <= data.length) {
        const key = latin1Decoder.decode(data.subarray(0, nul1));
        const compFlag = data[nul1 + 1] ?? 0;
        const nul2 = findZeroByte(data, nul1 + 3);
        const nul3 = nul2 >= 0 ? findZeroByte(data, nul2 + 1) : -1;
        if (nul3 >= 0) {
          const textBytes = data.subarray(nul3 + 1);
          let text = '';
          if (compFlag === 1) {
            try {
              text = utf8Decoder.decode(unzlibSync(textBytes)).trim();
            } catch {
              text = `<compressed iTXt ${textBytes.length} bytes>`;
            }
          } else {
            text = utf8Decoder.decode(textBytes).trim();
          }

          if (key === 'XML:com.adobe.xmp' && text) {
            fields.push(...extractXmpFields(text));
          } else if (text) {
            const { category, sensitive } = classifyMetadataKey(key);
            fields.push({
              key,
              label: formatTagLabel(key),
              value: text,
              category,
              sensitive,
            });
          }
        }
      }
    } else if (type === 'tIME' && data.length === 7) {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const year = dv.getUint16(0, false);
      const month = String(data[2] ?? 0).padStart(2, '0');
      const day = String(data[3] ?? 0).padStart(2, '0');
      const hour = String(data[4] ?? 0).padStart(2, '0');
      const min = String(data[5] ?? 0).padStart(2, '0');
      const sec = String(data[6] ?? 0).padStart(2, '0');
      fields.push({
        key: 'tIME',
        label: 'PNG Modification Time',
        value: `${year}-${month}-${day}T${hour}:${min}:${sec}Z`,
        category: 'dates',
        sensitive: true,
      });
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  return { fields, hasGps, orientation, hasIccProfile };
}

async function inspectWebp(bytes: Uint8Array): Promise<{
  fields: MetadataField[];
  hasGps: boolean;
  orientation: number | null;
  hasIccProfile: boolean;
}> {
  const fields: MetadataField[] = [];
  let hasGps = false;
  let orientation: number | null = null;
  let hasIccProfile = false;

  if (
    bytes.length < 12 ||
    !startsWithAscii(bytes, 0, 'RIFF') ||
    !startsWithAscii(bytes, 8, 'WEBP')
  ) {
    return { fields, hasGps, orientation, hasIccProfile };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const fourcc = latin1Decoder.decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) break;

    const payload = bytes.subarray(dataStart, dataEnd);

    if (fourcc === 'ICCP') {
      hasIccProfile = true;
    } else if (fourcc === 'EXIF') {
      const exifParsed = await parseRawExifChunk(payload, 'EXIF');
      fields.push(...exifParsed.fields);
      hasGps = hasGps || exifParsed.hasGps;
      if (orientation === null && exifParsed.orientation !== null) {
        orientation = exifParsed.orientation;
      }
    } else if (fourcc === 'XMP ') {
      const xml = utf8Decoder.decode(payload).replace(/\0+$/, '');
      fields.push(...extractXmpFields(xml));
    }

    const paddedSize = (size + 1) & ~1;
    offset = dataStart + paddedSize;
  }

  return { fields, hasGps, orientation, hasIccProfile };
}

/**
 * Inspect a JPEG, PNG, or WebP image and normalize all discovered metadata
 * into a MetadataReport. Standalone ICC profiles are tracked via `hasIccProfile`
 * and excluded from `totalTags` so clean ICC-preserving outputs verify as clean.
 */
export async function inspectImage(
  bytes: Uint8Array,
  format: 'jpeg' | 'png' | 'webp'
): Promise<MetadataReport> {
  let allFields: MetadataField[] = [];
  let hasGps = false;
  let orientation: number | null = null;
  let hasIccProfile = false;

  if (format === 'webp') {
    const webp = await inspectWebp(bytes);
    allFields = webp.fields;
    hasGps = webp.hasGps;
    orientation = webp.orientation;
    hasIccProfile = webp.hasIccProfile;
  } else {
    try {
      const parsed = (await exifr.parse(bytes, EXIFR_OPTIONS)) as
        | Record<string, unknown>
        | undefined;
      const extracted = extractExifrFields(parsed);
      allFields.push(...extracted.fields);
      hasGps = extracted.hasGps;
      orientation = extracted.orientation;
      hasIccProfile = extracted.hasIccProfile;
    } catch {
      // Fallback chunk/marker scanner still runs below
    }

    if (format === 'jpeg') {
      const jpegFallback = scanJpegMarkersFallback(bytes);
      allFields.push(...jpegFallback.fields);
      hasIccProfile = hasIccProfile || jpegFallback.hasIccProfile;
    } else if (format === 'png') {
      const pngFallback = await scanPngChunksFallback(bytes);
      allFields.push(...pngFallback.fields);
      hasGps = hasGps || pngFallback.hasGps;
      if (orientation === null && pngFallback.orientation !== null) {
        orientation = pngFallback.orientation;
      }
      hasIccProfile = hasIccProfile || pngFallback.hasIccProfile;
    }
  }

  const fields = deduplicateFields(allFields);
  hasGps = hasGps || hasGpsField(fields);
  const totalTags = fields.length;

  return {
    format,
    riskLevel: computeRiskLevel(hasGps, totalTags),
    hasGps,
    orientation,
    hasIccProfile,
    isSignedPdf: false,
    embeddedImageWithMetaCount: 0,
    fields,
    totalTags,
  };
}
