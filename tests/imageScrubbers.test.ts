import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspectImage } from '../src/core/inspector/inspectImage';
import { scrubJpegLossless } from '../src/core/scrubbers/jpegScrubber';
import { scrubPngLossless } from '../src/core/scrubbers/pngScrubber';
import { scrubWebpLossless } from '../src/core/scrubbers/webpScrubber';
import { bakeOrientedImageCanvas } from '../src/core/scrubbers/canvasFallback';
import {
  buildJpegWithExif,
  buildMinimalExifTiff,
  buildPngWithMeta,
  buildWebpWithMeta,
  crc32,
} from './helpers/fixtures';

const textEncoder = new TextEncoder();
const latin1Decoder = new TextDecoder('latin1');

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function findSequence(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function collectJpegMarkers(bytes: Uint8Array): number[] {
  const markers: number[] = [];
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset++;
    markers.push(marker);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda || marker === 0xd9) break;
    const len = ((bytes[offset]! << 8) | bytes[offset + 1]!);
    offset += len;
  }
  return markers;
}

interface ParsedPngChunk {
  type: string;
  data: Uint8Array;
  crc: number;
  computedCrc: number;
}

function parsePngChunks(bytes: Uint8Array): ParsedPngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: ParsedPngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const len = view.getUint32(offset, false);
    const type = latin1Decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    const crc = view.getUint32(offset + 8 + len, false);
    const computedCrc = crc32(bytes.subarray(offset + 4, offset + 8 + len));
    chunks.push({ type, data, crc, computedCrc });
    offset += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function parseWebpChunks(bytes: Uint8Array): {
  riffSize: number;
  chunks: Array<{ fourcc: string; data: Uint8Array }>;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true);
  const chunks: Array<{ fourcc: string; data: Uint8Array }> = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = latin1Decoder.decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    chunks.push({ fourcc, data });
    offset += 8 + ((size + 1) & ~1);
  }
  return { riffSize, chunks };
}

describe('scrubJpegLossless', () => {
  it('strips APP1 (EXIF + XMP), APP13, COM, and non-ICC APP2 while preserving APP0, APP14, SOS entropy stream, and optional ICC', async () => {
    const jpegWithAll = buildJpegWithExif({
      gps: [23.8103, 90.4125],
      make: 'Nikon',
      model: 'Z8',
      orientation: 6,
      software: 'Lightroom',
      dateTimeOriginal: '2026:03:01 10:20:30',
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Jane"/></rdf:RDF></x:xmpmeta>',
      icc: true,
      iptc: true,
      app14: true,
      comment: 'Secret photographer note',
    });

    // Inject a non-ICC APP2 segment (e.g. MPF/FlashPix extension) + 0xFF fill + TEM (0xFF01) before DQT
    const dqtIdx = findSequence(jpegWithAll, new Uint8Array([0xff, 0xdb]));
    expect(dqtIdx).toBeGreaterThan(2);

    const mpfPayload = textEncoder.encode('MPF\0extra-metadata');
    const nonIccApp2 = concatBytes([
      new Uint8Array([0xff, 0xe2, 0x00, mpfPayload.length + 2]),
      mpfPayload,
    ]);
    const paddedAndStandalone = new Uint8Array([0xff, 0xff, 0x01]); // fill 0xFF + TEM

    const jpegComplex = concatBytes([
      jpegWithAll.subarray(0, dqtIdx),
      nonIccApp2,
      paddedAndStandalone,
      jpegWithAll.subarray(dqtIdx),
    ]);

    // Inject 0xFF 0x00 stuffed byte and 0xFF 0xD0 (RST0) inside SOS entropy data before EOI
    const eoiPos = jpegComplex.length - 2;
    const jpegWithScanStuffing = concatBytes([
      jpegComplex.subarray(0, eoiPos),
      new Uint8Array([0xff, 0x00, 0xff, 0xd0, 0x12, 0x34]),
      jpegComplex.subarray(eoiPos),
    ]);

    // Locate original SOS..EOI slice
    const origSosIdx = findSequence(jpegWithScanStuffing, new Uint8Array([0xff, 0xda]));
    expect(origSosIdx).toBeGreaterThan(0);
    const origSosToEoi = jpegWithScanStuffing.subarray(origSosIdx);

    // 1) preserveIcc: true
    const keptIcc = scrubJpegLossless(jpegWithScanStuffing, { preserveIcc: true });
    const keptMarkers = collectJpegMarkers(keptIcc);
    expect(keptMarkers).toContain(0xe0); // APP0
    expect(keptMarkers).toContain(0xee); // APP14
    expect(keptMarkers.filter((m) => m === 0xe2)).toHaveLength(1); // Only ICC_PROFILE APP2, non-ICC APP2 stripped
    expect(keptMarkers).not.toContain(0xe1);
    expect(keptMarkers).not.toContain(0xed);
    expect(keptMarkers).not.toContain(0xfe);

    const cleanSosIdxKeep = findSequence(keptIcc, new Uint8Array([0xff, 0xda]));
    expect(cleanSosIdxKeep).toBeGreaterThan(0);
    expect(keptIcc.subarray(cleanSosIdxKeep)).toEqual(origSosToEoi);

    const reportKeep = await inspectImage(keptIcc, 'jpeg');
    expect(reportKeep.totalTags).toBe(0);
    expect(reportKeep.hasGps).toBe(false);
    expect(reportKeep.orientation).toBeNull();
    expect(reportKeep.hasIccProfile).toBe(true);
    expect(reportKeep.riskLevel).toBe('clean');

    // 2) preserveIcc: false
    const strippedIcc = scrubJpegLossless(jpegWithScanStuffing, { preserveIcc: false });
    const strippedMarkers = collectJpegMarkers(strippedIcc);
    expect(strippedMarkers).toContain(0xe0);
    expect(strippedMarkers).toContain(0xee);
    expect(strippedMarkers).not.toContain(0xe2);
    expect(strippedMarkers).not.toContain(0xe1);
    expect(strippedMarkers).not.toContain(0xed);
    expect(strippedMarkers).not.toContain(0xfe);

    const cleanSosIdxDrop = findSequence(strippedIcc, new Uint8Array([0xff, 0xda]));
    expect(strippedIcc.subarray(cleanSosIdxDrop)).toEqual(origSosToEoi);

    const reportDrop = await inspectImage(strippedIcc, 'jpeg');
    expect(reportDrop.totalTags).toBe(0);
    expect(reportDrop.hasIccProfile).toBe(false);
    expect(reportDrop.riskLevel).toBe('clean');
  });

  it('throws descriptive errors on malformed or truncated JPEGs', () => {
    expect(() => scrubJpegLossless(new Uint8Array([0x00, 0xd8, 0xff, 0xd9]), { preserveIcc: false })).toThrow(
      /SOI/i
    );

    // Truncated segment length extending past EOF
    const valid = buildJpegWithExif({ comment: 'hello' });
    const comIdx = findSequence(valid, new Uint8Array([0xff, 0xfe]));
    const truncatedSeg = valid.slice();
    truncatedSeg[comIdx + 2] = 0x7f;
    truncatedSeg[comIdx + 3] = 0xff;
    expect(() => scrubJpegLossless(truncatedSeg, { preserveIcc: true })).toThrow(/truncat|length|bound/i);

    // Segment length < 2
    const badLen = valid.slice();
    badLen[comIdx + 2] = 0x00;
    badLen[comIdx + 3] = 0x01;
    expect(() => scrubJpegLossless(badLen, { preserveIcc: true })).toThrow(/length/i);

    // Missing EOI
    const noEoi = valid.subarray(0, valid.length - 2);
    expect(() => scrubJpegLossless(noEoi, { preserveIcc: true })).toThrow(/EOI/i);

    // Missing SOS
    const noSos = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    expect(() => scrubJpegLossless(noSos, { preserveIcc: true })).toThrow(/SOS/i);
  });
});

describe('scrubPngLossless', () => {
  it('strips eXIf, tEXt, zTXt, iTXt, tIME while preserving IHDR, rendering chunks, byte-identical IDAT, IEND, valid CRC32, and conditional iCCP', async () => {
    const pngBase = buildPngWithMeta({
      exif: buildMinimalExifTiff({ gps: [40.7128, -74.006], make: 'Sony', orientation: 3 }),
      text: { Software: 'GIMP 2.10', Author: 'Bob' },
      ztxt: { Comment: 'Compressed comment' },
      itxt: { Description: 'Secret location' },
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Bob"/></rdf:RDF></x:xmpmeta>',
      time: new Date('2026-04-10T08:30:00Z'),
      iccp: true,
    });

    // Splice an sRGB chunk before IDAT to verify rendering chunks are preserved byte-identical
    const origChunks = parsePngChunks(pngBase);
    const origIdat = origChunks.find((c) => c.type === 'IDAT')!;
    const idatPos = findSequence(pngBase, textEncoder.encode('IDAT')) - 4;
    const srgbData = new Uint8Array([0x00]);
    const srgbTypeAndData = concatBytes([textEncoder.encode('sRGB'), srgbData]);
    const srgbChunk = concatBytes([
      new Uint8Array([0, 0, 0, 1]),
      srgbTypeAndData,
      new Uint8Array([
        (crc32(srgbTypeAndData) >>> 24) & 0xff,
        (crc32(srgbTypeAndData) >>> 16) & 0xff,
        (crc32(srgbTypeAndData) >>> 8) & 0xff,
        crc32(srgbTypeAndData) & 0xff,
      ]),
    ]);
    const pngWithSrgb = concatBytes([pngBase.subarray(0, idatPos), srgbChunk, pngBase.subarray(idatPos)]);

    // 1) preserveIcc: true
    const cleanKeepIcc = scrubPngLossless(pngWithSrgb, { preserveIcc: true });
    const chunksKeep = parsePngChunks(cleanKeepIcc);
    const typesKeep = chunksKeep.map((c) => c.type);
    expect(typesKeep).toEqual(['IHDR', 'iCCP', 'sRGB', 'IDAT', 'IEND']);
    expect(chunksKeep.find((c) => c.type === 'IDAT')!.data).toEqual(origIdat.data);
    for (const chunk of chunksKeep) {
      expect(chunk.crc).toBe(chunk.computedCrc);
    }

    const reportKeep = await inspectImage(cleanKeepIcc, 'png');
    expect(reportKeep.totalTags).toBe(0);
    expect(reportKeep.hasGps).toBe(false);
    expect(reportKeep.hasIccProfile).toBe(true);
    expect(reportKeep.riskLevel).toBe('clean');

    // 2) preserveIcc: false
    const cleanDropIcc = scrubPngLossless(pngWithSrgb, { preserveIcc: false });
    const chunksDrop = parsePngChunks(cleanDropIcc);
    expect(chunksDrop.map((c) => c.type)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    expect(chunksDrop.find((c) => c.type === 'IDAT')!.data).toEqual(origIdat.data);
    for (const chunk of chunksDrop) {
      expect(chunk.crc).toBe(chunk.computedCrc);
    }

    const reportDrop = await inspectImage(cleanDropIcc, 'png');
    expect(reportDrop.totalTags).toBe(0);
    expect(reportDrop.hasIccProfile).toBe(false);
    expect(reportDrop.riskLevel).toBe('clean');
  });

  it('throws descriptive errors on malformed or truncated PNGs', () => {
    expect(() => scrubPngLossless(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), { preserveIcc: true })).toThrow(
      /signature/i
    );

    const png = buildPngWithMeta({ text: { Author: 'Alice' } });
    // Truncate in the middle of IDAT
    const truncated = png.subarray(0, png.length - 10);
    expect(() => scrubPngLossless(truncated, { preserveIcc: true })).toThrow(/truncat|IEND/i);

    // Inflate chunk length beyond buffer bounds
    const badChunk = png.slice();
    badChunk[8] = 0x10; // IHDR length huge
    expect(() => scrubPngLossless(badChunk, { preserveIcc: true })).toThrow(/truncat|length|bound/i);
  });
});

describe('scrubWebpLossless', () => {
  it('strips EXIF and odd/even XMP, clears VP8X bits, conditionally drops ICCP, updates RIFF size, and passes inspectImage', async () => {
    // Odd-length XMP string -> tests RIFF 2-byte pad handling
    const oddXmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="OddUser1"/></rdf:RDF></x:xmpmeta>';
    expect(textEncoder.encode(oddXmp).length % 2).toBe(1);

    const webp = buildWebpWithMeta({
      exif: buildMinimalExifTiff({ gps: [51.5074, -0.1278], make: 'Google', orientation: 8 }),
      xmp: oddXmp,
      iccp: true,
    });
    // Also set Alpha bit (0x10) on VP8X to verify unrelated VP8X flags remain untouched
    const vp8xIdx = findSequence(webp, textEncoder.encode('VP8X'));
    expect(vp8xIdx).toBeGreaterThan(0);
    webp[vp8xIdx + 8] = (webp[vp8xIdx + 8] ?? 0) | 0x10;

    // 1) preserveIcc: true
    const keepIcc = scrubWebpLossless(webp, { preserveIcc: true });
    const parsedKeep = parseWebpChunks(keepIcc);
    expect(parsedKeep.riffSize).toBe(keepIcc.length - 8);
    expect(parsedKeep.chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ICCP', 'VP8L']);
    const vp8xKeepFlags = parsedKeep.chunks[0]!.data[0]!;
    expect(vp8xKeepFlags & 0x08).toBe(0); // EXIF bit cleared
    expect(vp8xKeepFlags & 0x04).toBe(0); // XMP bit cleared
    expect(vp8xKeepFlags & 0x20).toBe(0x20); // ICC bit preserved
    expect(vp8xKeepFlags & 0x10).toBe(0x10); // Alpha bit preserved

    const reportKeep = await inspectImage(keepIcc, 'webp');
    expect(reportKeep.totalTags).toBe(0);
    expect(reportKeep.hasGps).toBe(false);
    expect(reportKeep.hasIccProfile).toBe(true);
    expect(reportKeep.riskLevel).toBe('clean');

    // 2) preserveIcc: false (also test even-length XMP)
    const evenXmp = oddXmp + ' ';
    expect(textEncoder.encode(evenXmp).length % 2).toBe(0);
    const webpEven = buildWebpWithMeta({
      exif: buildMinimalExifTiff({ make: 'Apple' }),
      xmp: evenXmp,
      iccp: true,
    });

    const dropIcc = scrubWebpLossless(webpEven, { preserveIcc: false });
    const parsedDrop = parseWebpChunks(dropIcc);
    expect(parsedDrop.riffSize).toBe(dropIcc.length - 8);
    expect(parsedDrop.chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8L']);
    const vp8xDropFlags = parsedDrop.chunks[0]!.data[0]!;
    expect(vp8xDropFlags & (0x08 | 0x04 | 0x20)).toBe(0);

    const reportDrop = await inspectImage(dropIcc, 'webp');
    expect(reportDrop.totalTags).toBe(0);
    expect(reportDrop.hasIccProfile).toBe(false);
    expect(reportDrop.riskLevel).toBe('clean');

    // 3) Odd-length XMP chunk BEFORE VP8L verifies padded offset advance across chunks
    const oddXmpBytes = textEncoder.encode(oddXmp);
    const xmpChunk = concatBytes([
      textEncoder.encode('XMP '),
      new Uint8Array([
        oddXmpBytes.length & 0xff,
        (oddXmpBytes.length >>> 8) & 0xff,
        (oddXmpBytes.length >>> 16) & 0xff,
        (oddXmpBytes.length >>> 24) & 0xff,
      ]),
      oddXmpBytes,
      new Uint8Array([0x00]), // RIFF even pad byte
    ]);
    const vp8lChunk = new Uint8Array([
      0x56, 0x50, 0x38, 0x4c, // 'VP8L'
      0x08, 0x00, 0x00, 0x00,
      0x2f, 0x01, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const preVp8lBody = concatBytes([xmpChunk, vp8lChunk]);
    const riffLen = 4 + preVp8lBody.length;
    const webpOddBeforeImage = concatBytes([
      textEncoder.encode('RIFF'),
      new Uint8Array([
        riffLen & 0xff,
        (riffLen >>> 8) & 0xff,
        (riffLen >>> 16) & 0xff,
        (riffLen >>> 24) & 0xff,
      ]),
      textEncoder.encode('WEBP'),
      preVp8lBody,
    ]);
    const cleanedOddBefore = scrubWebpLossless(webpOddBeforeImage, { preserveIcc: false });
    const parsedOddBefore = parseWebpChunks(cleanedOddBefore);
    expect(parsedOddBefore.riffSize).toBe(cleanedOddBefore.length - 8);
    expect(parsedOddBefore.chunks.map((c) => c.fourcc)).toEqual(['VP8L']);
  });

  it('throws descriptive errors on malformed or truncated WebP files', () => {
    expect(() => scrubWebpLossless(new Uint8Array([0, 1, 2, 3]), { preserveIcc: false })).toThrow(/RIFF|WEBP/i);

    const valid = buildWebpWithMeta({ exif: buildMinimalExifTiff({ make: 'Fuji' }) });
    const truncated = valid.subarray(0, valid.length - 6);
    expect(() => scrubWebpLossless(truncated, { preserveIcc: false })).toThrow(/truncat|size|bound/i);
  });
});

describe('bakeOrientedImageCanvas', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses createImageBitmap(from-image) and OffscreenCanvas.convertToBlob(image/jpeg, 0.95), dropping ICC/metadata', async () => {
    const cleanOutputJpeg = buildJpegWithExif({});
    const closeSpy = vi.fn();
    const drawImageSpy = vi.fn();
    const convertToBlobSpy = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array(cleanOutputJpeg)], { type: 'image/jpeg' }));
    const createImageBitmapSpy = vi.fn().mockResolvedValue({
      width: 2,
      height: 2,
      close: closeSpy,
    });

    class MockOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext(kind: string) {
        expect(kind).toBe('2d');
        return { drawImage: drawImageSpy };
      }
      convertToBlob(opts?: ImageEncodeOptions) {
        return convertToBlobSpy(opts);
      }
    }

    vi.stubGlobal('createImageBitmap', createImageBitmapSpy);
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

    const orientedInput = buildJpegWithExif({ orientation: 6, icc: true, gps: [10, 20] });
    const result = await bakeOrientedImageCanvas(orientedInput, 'image/jpeg');

    expect(createImageBitmapSpy).toHaveBeenCalledTimes(1);
    const [blobArg, optsArg] = createImageBitmapSpy.mock.calls[0]!;
    expect(blobArg).toBeInstanceOf(Blob);
    expect((blobArg as Blob).type).toBe('image/jpeg');
    expect(optsArg).toEqual({ imageOrientation: 'from-image' });

    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    expect(convertToBlobSpy).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.95 });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual(cleanOutputJpeg);

    const report = await inspectImage(result, 'jpeg');
    expect(report.totalTags).toBe(0);
    expect(report.hasIccProfile).toBe(false);
  });

  it('falls back to HTMLCanvasElement when OffscreenCanvas is unavailable', async () => {
    const cleanOutputJpeg = buildJpegWithExif({});
    const closeSpy = vi.fn();
    const drawImageSpy = vi.fn();
    const toBlobSpy = vi.fn((cb: (blob: Blob | null) => void, type?: string, quality?: number) => {
      expect(type).toBe('image/jpeg');
      expect(quality).toBe(0.95);
      cb(new Blob([new Uint8Array(cleanOutputJpeg)], { type: 'image/jpeg' }));
    });

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: drawImageSpy })),
      toBlob: toBlobSpy,
    };

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return mockCanvas as unknown as HTMLCanvasElement;
      }
      return origCreateElement(tagName);
    });

    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 4, height: 3, close: closeSpy })
    );

    const input = buildJpegWithExif({ orientation: 3 });
    const result = await bakeOrientedImageCanvas(input, 'image/jpeg');

    expect(mockCanvas.width).toBe(4);
    expect(mockCanvas.height).toBe(3);
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    expect(toBlobSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual(cleanOutputJpeg);
  });

  it('skips OffscreenCanvas allocation when OffscreenCanvas.prototype.convertToBlob is missing and falls back when 2D context is null', async () => {
    const cleanOutputJpeg = buildJpegWithExif({});
    const closeSpy = vi.fn();
    const domDrawImageSpy = vi.fn();
    const toBlobSpy = vi.fn((cb: (blob: Blob | null) => void) => {
      cb(new Blob([new Uint8Array(cleanOutputJpeg)], { type: 'image/jpeg' }));
    });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: domDrawImageSpy })),
      toBlob: toBlobSpy,
    };

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return mockCanvas as unknown as HTMLCanvasElement;
      }
      return origCreateElement(tagName);
    });

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 3, height: 2, close: closeSpy })
    );

    // 1. OffscreenCanvas exists but prototype.convertToBlob is missing -> never constructs OffscreenCanvas
    const offscreenCtorSpy = vi.fn();
    class NoConvertToBlobOffscreenCanvas {
      constructor(width: number, height: number) {
        offscreenCtorSpy(width, height);
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
    }
    vi.stubGlobal('OffscreenCanvas', NoConvertToBlobOffscreenCanvas);

    const input = buildJpegWithExif({ orientation: 6 });
    const res1 = await bakeOrientedImageCanvas(input, 'image/jpeg');
    expect(offscreenCtorSpy).not.toHaveBeenCalled();
    expect(res1).toEqual(cleanOutputJpeg);

    // 2. OffscreenCanvas.prototype.convertToBlob exists but getContext('2d') returns null -> falls back to DOM canvas
    class NullContextOffscreenCanvas {
      getContext() {
        return null;
      }
      convertToBlob() {
        return Promise.resolve(new Blob());
      }
    }
    vi.stubGlobal('OffscreenCanvas', NullContextOffscreenCanvas);

    const res2 = await bakeOrientedImageCanvas(input, 'image/jpeg');
    expect(domDrawImageSpy).toHaveBeenCalledTimes(2);
    expect(res2).toEqual(cleanOutputJpeg);
  });
});
