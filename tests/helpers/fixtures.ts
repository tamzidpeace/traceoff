import { zlibSync } from 'fflate';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

const textEncoder = new TextEncoder();

export interface ExifFixtureOptions {
  gps?: [number, number];
  make?: string;
  model?: string;
  orientation?: number;
  software?: string;
  dateTimeOriginal?: string;
}

export interface JpegFixtureOptions extends ExifFixtureOptions {
  xmp?: string;
  icc?: boolean;
  comment?: string;
  iptc?: boolean;
  app14?: boolean;
}

export interface PngFixtureOptions {
  exif?: Uint8Array;
  text?: Record<string, string>;
  itxt?: Record<string, string>;
  ztxt?: Record<string, string>;
  xmp?: string;
  time?: Date;
  iccp?: boolean;
}

export interface WebpFixtureOptions {
  exif?: Uint8Array;
  xmp?: string;
  iccp?: boolean;
}

export interface PdfFixtureOptions {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  xmp?: string;
  pageXmp?: string;
  pieceInfo?: boolean;
  annotAuthor?: string;
  annotSubject?: string;
  embeddedJpeg?: Uint8Array;
  signed?: boolean;
  encrypted?: boolean;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function uint16BE(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function uint32BE(v: number): Uint8Array {
  return new Uint8Array([
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
}

function uint32LE(v: number): Uint8Array {
  return new Uint8Array([
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  ]);
}

/**
 * Minimal 132-byte ICC profile header (sRGB stub) with valid size & 'acsp' magic.
 */
export function buildMinimalIccProfile(): Uint8Array {
  const icc = new Uint8Array(132);
  const view = new DataView(icc.buffer);
  view.setUint32(0, 132, false); // profile size
  icc.set(textEncoder.encode('ADBE'), 4);
  view.setUint32(8, 0x02100000, false); // version 2.1.0
  icc.set(textEncoder.encode('mntr'), 12); // display device class
  icc.set(textEncoder.encode('RGB '), 16); // color space
  icc.set(textEncoder.encode('XYZ '), 20); // PCS
  icc.set(textEncoder.encode('acsp'), 36); // magic signature
  icc.set(textEncoder.encode('APPL'), 40); // platform
  // Tag count = 0 at offset 128 (already zeroed)
  return icc;
}

interface TiffEntrySpec {
  tag: number;
  type: number; // 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL
  count: number;
  inlineValue?: number;
  data?: Uint8Array;
}

function toDmsRationals(decimalDeg: number): Uint8Array {
  const abs = Math.abs(decimalDeg);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const secFloat = (minFloat - min) * 60;
  const secNumerator = Math.round(secFloat * 10000);
  const buf = new Uint8Array(24);
  const view = new DataView(buf.buffer);
  view.setUint32(0, deg, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, min, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, secNumerator, true);
  view.setUint32(20, 10000, true);
  return buf;
}

function encodeAscii(value: string): Uint8Array {
  const raw = textEncoder.encode(value);
  const out = new Uint8Array(raw.length + 1);
  out.set(raw, 0);
  return out;
}

function padEven(bytes: Uint8Array): Uint8Array {
  if (bytes.length % 2 === 0) return bytes;
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes, 0);
  return padded;
}

function serializeIfd(
  entries: TiffEntrySpec[],
  startOffset: number,
  nextIfdOffset = 0
): { bytes: Uint8Array; totalSize: number } {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const headerSize = 2 + sorted.length * 12 + 4;
  let extraOffset = startOffset + headerSize;
  const extraChunks: Uint8Array[] = [];
  const dir = new Uint8Array(headerSize);
  const view = new DataView(dir.buffer);
  view.setUint16(0, sorted.length, true);

  sorted.forEach((entry, idx) => {
    const pos = 2 + idx * 12;
    view.setUint16(pos, entry.tag, true);
    view.setUint16(pos + 2, entry.type, true);
    view.setUint32(pos + 4, entry.count, true);

    if (entry.data !== undefined) {
      if (entry.data.length <= 4) {
        dir.set(entry.data, pos + 8);
      } else {
        view.setUint32(pos + 8, extraOffset, true);
        const padded = padEven(entry.data);
        extraChunks.push(padded);
        extraOffset += padded.length;
      }
    } else {
      view.setUint32(pos + 8, entry.inlineValue ?? 0, true);
    }
  });

  view.setUint32(2 + sorted.length * 12, nextIfdOffset, true);
  const bytes = concatBytes([dir, ...extraChunks]);
  return { bytes, totalSize: bytes.length };
}

/**
 * Build a minimal little-endian TIFF EXIF payload (starting with "II*\0").
 */
export function buildMinimalExifTiff(opts: ExifFixtureOptions = {}): Uint8Array {
  const ifd0Entries: TiffEntrySpec[] = [];
  if (opts.make !== undefined) {
    const data = encodeAscii(opts.make);
    ifd0Entries.push({ tag: 0x010f, type: 2, count: data.length, data });
  }
  if (opts.model !== undefined) {
    const data = encodeAscii(opts.model);
    ifd0Entries.push({ tag: 0x0110, type: 2, count: data.length, data });
  }
  if (opts.orientation !== undefined) {
    ifd0Entries.push({
      tag: 0x0112,
      type: 3,
      count: 1,
      inlineValue: opts.orientation,
    });
  }
  if (opts.software !== undefined) {
    const data = encodeAscii(opts.software);
    ifd0Entries.push({ tag: 0x0131, type: 2, count: data.length, data });
  }

  const exifEntries: TiffEntrySpec[] = [];
  if (opts.dateTimeOriginal !== undefined) {
    const data = encodeAscii(opts.dateTimeOriginal);
    exifEntries.push({ tag: 0x9003, type: 2, count: data.length, data });
  }

  const gpsEntries: TiffEntrySpec[] = [];
  if (opts.gps !== undefined) {
    const [lat, lng] = opts.gps;
    const latRef = encodeAscii(lat >= 0 ? 'N' : 'S');
    const lngRef = encodeAscii(lng >= 0 ? 'E' : 'W');
    gpsEntries.push(
      { tag: 0x0001, type: 2, count: latRef.length, data: latRef },
      { tag: 0x0002, type: 5, count: 3, data: toDmsRationals(lat) },
      { tag: 0x0003, type: 2, count: lngRef.length, data: lngRef },
      { tag: 0x0004, type: 5, count: 3, data: toDmsRationals(lng) }
    );
  }

  // Reserve placeholder pointers in IFD0 so IFD0 size is fixed before computing offsets
  const hasExif = exifEntries.length > 0;
  const hasGps = gpsEntries.length > 0;
  if (hasExif) {
    ifd0Entries.push({ tag: 0x8769, type: 4, count: 1, inlineValue: 0 });
  }
  if (hasGps) {
    ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, inlineValue: 0 });
  }

  const tiffHeader = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const ifd0Draft = serializeIfd(ifd0Entries, 8);
  let cursor = 8 + ifd0Draft.totalSize;

  let exifBytes: Uint8Array = new Uint8Array(0);
  if (hasExif) {
    const exifPointerEntry = ifd0Entries.find((e) => e.tag === 0x8769);
    if (exifPointerEntry) exifPointerEntry.inlineValue = cursor;
    const exifSerialized = serializeIfd(exifEntries, cursor);
    exifBytes = exifSerialized.bytes;
    cursor += exifSerialized.totalSize;
  }

  let gpsBytes: Uint8Array = new Uint8Array(0);
  if (hasGps) {
    const gpsPointerEntry = ifd0Entries.find((e) => e.tag === 0x8825);
    if (gpsPointerEntry) gpsPointerEntry.inlineValue = cursor;
    const gpsSerialized = serializeIfd(gpsEntries, cursor);
    gpsBytes = gpsSerialized.bytes;
  }

  const ifd0Final = serializeIfd(ifd0Entries, 8);
  return concatBytes([tiffHeader, ifd0Final.bytes, exifBytes, gpsBytes]);
}

function buildJpegSegment(marker2: number, payload: Uint8Array): Uint8Array {
  return concatBytes([
    new Uint8Array([0xff, marker2]),
    uint16BE(payload.length + 2),
    payload,
  ]);
}

/**
 * Minimal valid baseline 2x2 grayscale JPEG frames + entropy scan.
 */
function buildMinimalJpegImageData(): Uint8Array {
  // DQT (table 0, 8-bit, all 1s)
  const dqt = buildJpegSegment(
    0xdb,
    concatBytes([new Uint8Array([0x00]), new Uint8Array(64).fill(1)])
  );

  // SOF0: 8-bit precision, 2x2, 1 component (Y, 1x1 sampling, quant table 0)
  const sof0 = buildJpegSegment(
    0xc0,
    new Uint8Array([0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00])
  );

  // DHT DC table 0: 1 symbol of length 1 (code 0 -> category 0)
  const dhtDc = buildJpegSegment(
    0xc4,
    new Uint8Array([
      0x00,
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0x00,
    ])
  );

  // DHT AC table 0: 1 symbol of length 1 (code 0 -> EOB 0x00)
  const dhtAc = buildJpegSegment(
    0xc4,
    new Uint8Array([
      0x10,
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0x00,
    ])
  );

  // SOS: 1 component, DC/AC table 0, spectral 0..63, approx 0
  const sosHeader = buildJpegSegment(
    0xda,
    new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])
  );
  // 1 MCU = DC(0='0') + AC EOB('0') = 2 bits -> 0x00 byte
  const scanData = new Uint8Array([0x00]);
  const eoi = new Uint8Array([0xff, 0xd9]);

  return concatBytes([dqt, sof0, dhtDc, dhtAc, sosHeader, scanData, eoi]);
}

/**
 * Build a minimal valid JPEG with optional EXIF (GPS/Make/Orientation/etc.), XMP, ICC, COM, IPTC, APP14.
 */
export function buildJpegWithExif(opts: JpegFixtureOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];

  // Standard APP0 JFIF
  const jfifPayload = concatBytes([
    textEncoder.encode('JFIF\0'),
    new Uint8Array([0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00]),
  ]);
  parts.push(buildJpegSegment(0xe0, jfifPayload));

  const hasExifFields =
    opts.gps !== undefined ||
    opts.make !== undefined ||
    opts.model !== undefined ||
    opts.orientation !== undefined ||
    opts.software !== undefined ||
    opts.dateTimeOriginal !== undefined;

  if (hasExifFields) {
    const tiff = buildMinimalExifTiff(opts);
    parts.push(buildJpegSegment(0xe1, concatBytes([textEncoder.encode('Exif\0\0'), tiff])));
  }

  if (opts.xmp !== undefined) {
    parts.push(
      buildJpegSegment(
        0xe1,
        concatBytes([
          textEncoder.encode('http://ns.adobe.com/xap/1.0/\0'),
          textEncoder.encode(opts.xmp),
        ])
      )
    );
  }

  if (opts.icc) {
    const iccHeader = concatBytes([
      textEncoder.encode('ICC_PROFILE\0'),
      new Uint8Array([0x01, 0x01]),
      buildMinimalIccProfile(),
    ]);
    parts.push(buildJpegSegment(0xe2, iccHeader));
  }

  if (opts.iptc) {
    // Minimal APP13 Photoshop 3.0 + 8BIM IPTC tag (2:80 By-line = "Photographer")
    const val = textEncoder.encode('Photographer');
    const iptcRecord = concatBytes([
      new Uint8Array([0x1c, 0x02, 0x50]),
      uint16BE(val.length),
      val,
    ]);
    const paddedRecord = padEven(iptcRecord);
    const bim = concatBytes([
      textEncoder.encode('8BIM'),
      new Uint8Array([0x04, 0x04, 0x00, 0x00]),
      uint32BE(iptcRecord.length),
      paddedRecord,
    ]);
    parts.push(
      buildJpegSegment(0xed, concatBytes([textEncoder.encode('Photoshop 3.0\0'), bim]))
    );
  }

  if (opts.app14) {
    parts.push(
      buildJpegSegment(
        0xee,
        concatBytes([
          textEncoder.encode('Adobe\0'),
          new Uint8Array([0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]),
        ])
      )
    );
  }

  if (opts.comment !== undefined) {
    parts.push(buildJpegSegment(0xfe, textEncoder.encode(opts.comment)));
  }

  parts.push(buildMinimalJpegImageData());
  return concatBytes(parts);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    const entry = CRC_TABLE[(c ^ b) & 0xff] ?? 0;
    c = entry ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = textEncoder.encode(type);
  const typeAndData = concatBytes([typeBytes, data]);
  return concatBytes([uint32BE(data.length), typeAndData, uint32BE(crc32(typeAndData))]);
}

/**
 * Build a minimal valid 2x2 RGB PNG with optional iCCP, eXIf, tEXt, iTXt, zTXt, XMP, and tIME chunks.
 */
export function buildPngWithMeta(opts: PngFixtureOptions = {}): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: 2x2, bitDepth=8, colorType=2 (RGB), compression=0, filter=0, interlace=0
  const ihdrData = new Uint8Array([
    0x00, 0x00, 0x00, 0x02,
    0x00, 0x00, 0x00, 0x02,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
  const chunks: Uint8Array[] = [signature, buildPngChunk('IHDR', ihdrData)];

  if (opts.iccp) {
    const compressedIcc = zlibSync(buildMinimalIccProfile());
    const iccpData = concatBytes([textEncoder.encode('sRGB\0'), new Uint8Array([0]), compressedIcc]);
    chunks.push(buildPngChunk('iCCP', iccpData));
  }

  if (opts.exif) {
    let rawTiff = opts.exif;
    if (
      rawTiff.length >= 6 &&
      rawTiff[0] === 0x45 &&
      rawTiff[1] === 0x78 &&
      rawTiff[2] === 0x69 &&
      rawTiff[3] === 0x66 &&
      rawTiff[4] === 0x00 &&
      rawTiff[5] === 0x00
    ) {
      rawTiff = rawTiff.slice(6);
    }
    chunks.push(buildPngChunk('eXIf', rawTiff));
  }

  if (opts.text) {
    for (const [key, value] of Object.entries(opts.text)) {
      const payload = concatBytes([
        textEncoder.encode(key),
        new Uint8Array([0]),
        textEncoder.encode(value),
      ]);
      chunks.push(buildPngChunk('tEXt', payload));
    }
  }

  if (opts.ztxt) {
    for (const [key, value] of Object.entries(opts.ztxt)) {
      const compressed = zlibSync(textEncoder.encode(value));
      const payload = concatBytes([
        textEncoder.encode(key),
        new Uint8Array([0, 0]),
        compressed,
      ]);
      chunks.push(buildPngChunk('zTXt', payload));
    }
  }

  const itxtEntries: Record<string, string> = { ...(opts.itxt ?? {}) };
  if (opts.xmp !== undefined) {
    itxtEntries['XML:com.adobe.xmp'] = opts.xmp;
  }
  for (const [key, value] of Object.entries(itxtEntries)) {
    // keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text
    const payload = concatBytes([
      textEncoder.encode(key),
      new Uint8Array([0, 0, 0, 0, 0]),
      textEncoder.encode(value),
    ]);
    chunks.push(buildPngChunk('iTXt', payload));
  }

  if (opts.time) {
    const d = opts.time;
    const t = new Uint8Array([
      (d.getUTCFullYear() >> 8) & 0xff,
      d.getUTCFullYear() & 0xff,
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ]);
    chunks.push(buildPngChunk('tIME', t));
  }

  // 2x2 RGB raw scanlines: 2 rows * (1 filter byte + 6 RGB bytes) = 14 bytes
  const rawPixels = new Uint8Array(14);
  chunks.push(buildPngChunk('IDAT', zlibSync(rawPixels)));
  chunks.push(buildPngChunk('IEND', new Uint8Array(0)));

  return concatBytes(chunks);
}

function buildRiffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const header = concatBytes([textEncoder.encode(fourcc), uint32LE(data.length)]);
  const padded = padEven(data);
  return concatBytes([header, padded]);
}

/**
 * Minimal valid 2x2 VP8L lossless bitstream chunk payload (solid black 2x2).
 */
function buildMinimalVp8lPayload(): Uint8Array {
  // VP8L signature byte 0x2f, width-1 = 1 (14 bits), height-1 = 1 (14 bits), alpha=0, version=0
  // Packed 32-bit little-endian: (1) | (1 << 14) = 0x00004001 -> LE: 01 40 00 00
  return new Uint8Array([0x2f, 0x01, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/**
 * Build a minimal valid RIFF/WEBP file with optional VP8X, ICCP, EXIF, and XMP chunks.
 */
export function buildWebpWithMeta(opts: WebpFixtureOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const hasIcc = Boolean(opts.iccp);
  const hasExif = opts.exif !== undefined;
  const hasXmp = opts.xmp !== undefined;

  if (hasIcc || hasExif || hasXmp) {
    let flags = 0;
    if (hasIcc) flags |= 0x20;
    if (hasExif) flags |= 0x08;
    if (hasXmp) flags |= 0x04;
    const vp8x = new Uint8Array([
      flags, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, // width - 1 = 1 (2px)
      0x01, 0x00, 0x00, // height - 1 = 1 (2px)
    ]);
    chunks.push(buildRiffChunk('VP8X', vp8x));
  }

  if (hasIcc) {
    chunks.push(buildRiffChunk('ICCP', buildMinimalIccProfile()));
  }

  chunks.push(buildRiffChunk('VP8L', buildMinimalVp8lPayload()));

  if (opts.exif !== undefined) {
    chunks.push(buildRiffChunk('EXIF', opts.exif));
  }

  if (opts.xmp !== undefined) {
    chunks.push(buildRiffChunk('XMP ', textEncoder.encode(opts.xmp)));
  }

  const body = concatBytes(chunks);
  return concatBytes([
    textEncoder.encode('RIFF'),
    uint32LE(4 + body.length),
    textEncoder.encode('WEBP'),
    body,
  ]);
}

/**
 * Build a PDF using pdf-lib low-level objects with Info, XMP, PieceInfo,
 * Annotation authors, embedded JPEG XObjects, digital signature dicts, or /Encrypt trailer.
 */
export async function buildPdfWithDeepMeta(opts: PdfFixtureOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);

  if (opts.title !== undefined) doc.setTitle(opts.title);
  if (opts.author !== undefined) doc.setAuthor(opts.author);
  if (opts.subject !== undefined) doc.setSubject(opts.subject);
  if (opts.keywords !== undefined) doc.setKeywords(opts.keywords);
  if (opts.creator !== undefined) doc.setCreator(opts.creator);
  if (opts.producer !== undefined) doc.setProducer(opts.producer);
  if (opts.creationDate !== undefined) doc.setCreationDate(opts.creationDate);
  if (opts.modificationDate !== undefined) doc.setModificationDate(opts.modificationDate);

  if (opts.xmp !== undefined) {
    const xmpStream = doc.context.stream(opts.xmp, {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    const xmpRef = doc.context.register(xmpStream);
    doc.catalog.set(PDFName.of('Metadata'), xmpRef);
  }

  if (opts.pageXmp !== undefined) {
    const pageXmpStream = doc.context.stream(opts.pageXmp, {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    const pageXmpRef = doc.context.register(pageXmpStream);
    page.node.set(PDFName.of('Metadata'), pageXmpRef);
  }

  if (opts.pieceInfo) {
    const pieceDict = doc.context.obj({
      Illustrator: { LastModified: PDFString.of('D:20260101000000Z') },
    });
    doc.catalog.set(PDFName.of('PieceInfo'), pieceDict);
    page.node.set(PDFName.of('PieceInfo'), pieceDict);
  }

  if (opts.annotAuthor !== undefined || opts.annotSubject !== undefined) {
    const annotDict = PDFDict.withContext(doc.context);
    annotDict.set(PDFName.of('Type'), PDFName.of('Annot'));
    annotDict.set(PDFName.of('Subtype'), PDFName.of('Text'));
    annotDict.set(
      PDFName.of('Rect'),
      doc.context.obj([10, 10, 30, 30])
    );
    annotDict.set(PDFName.of('Contents'), PDFString.of('Review comment'));
    if (opts.annotAuthor !== undefined) {
      annotDict.set(PDFName.of('T'), PDFString.of(opts.annotAuthor));
    }
    if (opts.annotSubject !== undefined) {
      annotDict.set(PDFName.of('Subj'), PDFString.of(opts.annotSubject));
    }
    annotDict.set(PDFName.of('CreationDate'), PDFString.of('D:20260101100000Z'));
    annotDict.set(PDFName.of('M'), PDFString.of('D:20260102120000Z'));

    const annotRef = doc.context.register(annotDict);
    const annots = PDFArray.withContext(doc.context);
    annots.push(annotRef);
    page.node.set(PDFName.of('Annots'), annots);
  }

  if (opts.embeddedJpeg !== undefined) {
    const embedded = await doc.embedJpg(opts.embeddedJpeg);
    page.drawImage(embedded, { x: 10, y: 10, width: 100, height: 100 });
  }

  if (opts.signed) {
    const sigValue = PDFDict.withContext(doc.context);
    sigValue.set(PDFName.of('Type'), PDFName.of('Sig'));
    sigValue.set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'));
    sigValue.set(PDFName.of('SubFilter'), PDFName.of('adbe.pkcs7.detached'));
    sigValue.set(
      PDFName.of('ByteRange'),
      doc.context.obj([0, 128, 256, 128])
    );
    sigValue.set(PDFName.of('Contents'), PDFHexString.of('00000000'));
    const sigValueRef = doc.context.register(sigValue);

    const sigField = PDFDict.withContext(doc.context);
    sigField.set(PDFName.of('FT'), PDFName.of('Sig'));
    sigField.set(PDFName.of('T'), PDFString.of('Signature1'));
    sigField.set(PDFName.of('V'), sigValueRef);
    const sigFieldRef = doc.context.register(sigField);

    const acroForm = PDFDict.withContext(doc.context);
    const fields = PDFArray.withContext(doc.context);
    fields.push(sigFieldRef);
    acroForm.set(PDFName.of('Fields'), fields);
    acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
    const acroFormRef = doc.context.register(acroForm);
    doc.catalog.set(PDFName.of('AcroForm'), acroFormRef);
  }

  if (opts.encrypted) {
    const encryptDict = PDFDict.withContext(doc.context);
    encryptDict.set(PDFName.of('Filter'), PDFName.of('Standard'));
    encryptDict.set(PDFName.of('V'), PDFNumber.of(1));
    encryptDict.set(PDFName.of('R'), PDFNumber.of(2));
    encryptDict.set(PDFName.of('P'), PDFNumber.of(-4));
    encryptDict.set(PDFName.of('O'), PDFHexString.of('00'.repeat(32)));
    encryptDict.set(PDFName.of('U'), PDFHexString.of('00'.repeat(32)));
    doc.context.trailerInfo.Encrypt = doc.context.register(encryptDict);
  }

  return doc.save({ useObjectStreams: false });
}
