import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectFormat } from '../src/core/detectFormat';
import { PdfInspectError } from '../src/core/inspector/inspectPdf';
import {
  inspectFile,
  scrubFile,
  UnsupportedFormatError,
} from '../src/core/scrubFile';
import { PdfScrubError } from '../src/core/scrubbers/pdfScrubber';
import type { MetadataReport, ScrubOptions, ScrubResult } from '../src/core/types';
import { ScrubWorkerClient } from '../src/core/workerClient';
import {
  buildJpegWithExif,
  buildMinimalExifTiff,
  buildPdfWithDeepMeta,
  buildPngWithMeta,
  buildWebpWithMeta,
} from './helpers/fixtures';

const DEFAULT_OPTIONS: ScrubOptions = {
  preserveIcc: true,
  autoFixOrientation: true,
  allowSignedPdfScrub: false,
  filenameMode: 'suffix',
};

describe('inspectFile & scrubFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws UnsupportedFormatError on unknown bytes', async () => {
    const unknown = new TextEncoder().encode('hello world not an image');

    await expect(inspectFile(unknown)).rejects.toThrow(UnsupportedFormatError);
    await expect(inspectFile(unknown)).rejects.toMatchObject({
      code: 'unsupported-format',
    });

    await expect(scrubFile(unknown, DEFAULT_OPTIONS)).rejects.toThrow(
      UnsupportedFormatError
    );
    await expect(scrubFile(unknown, DEFAULT_OPTIONS)).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });

  it('scrubs JPEG, PNG, and WebP with mode "lossless" and verifies after.totalTags === 0', async () => {
    const jpeg = buildJpegWithExif({
      gps: [23.8103, 90.4125],
      make: 'Canon',
      model: 'EOS R5',
      icc: true,
      comment: 'Private note',
    });
    const jpegRes = await scrubFile(jpeg, DEFAULT_OPTIONS);
    expect(jpegRes.format).toBe('jpeg');
    expect(jpegRes.mode).toBe('lossless');
    expect(jpegRes.before.hasGps).toBe(true);
    expect(jpegRes.before.totalTags).toBeGreaterThan(0);
    expect(jpegRes.after.totalTags).toBe(0);
    expect(jpegRes.after.hasGps).toBe(false);
    expect(jpegRes.after.hasIccProfile).toBe(true);
    expect(jpegRes.after.riskLevel).toBe('clean');
    expect(jpegRes.originalSize).toBe(jpeg.byteLength);
    expect(jpegRes.cleanSize).toBe(jpegRes.cleanBytes.byteLength);
    expect(jpegRes.warnings).toEqual([]);

    const png = buildPngWithMeta({
      exif: buildMinimalExifTiff({ make: 'Sony', gps: [40.7128, -74.006] }),
      text: { Author: 'Alice', Software: 'Photoshop' },
      iccp: true,
    });
    const pngRes = await scrubFile(png, { ...DEFAULT_OPTIONS, preserveIcc: false });
    expect(pngRes.format).toBe('png');
    expect(pngRes.mode).toBe('lossless');
    expect(pngRes.before.totalTags).toBeGreaterThan(0);
    expect(pngRes.after.totalTags).toBe(0);
    expect(pngRes.after.hasIccProfile).toBe(false);
    expect(pngRes.after.riskLevel).toBe('clean');

    const webp = buildWebpWithMeta({
      exif: buildMinimalExifTiff({ make: 'Google', gps: [51.5074, -0.1278] }),
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Bob"/></rdf:RDF></x:xmpmeta>',
      iccp: true,
    });
    const webpRes = await scrubFile(webp, DEFAULT_OPTIONS);
    expect(webpRes.format).toBe('webp');
    expect(webpRes.mode).toBe('lossless');
    expect(webpRes.before.totalTags).toBeGreaterThan(0);
    expect(webpRes.after.totalTags).toBe(0);
    expect(webpRes.after.hasIccProfile).toBe(true);
    expect(webpRes.after.riskLevel).toBe('clean');
  });

  it('bakes oriented JPEG (Orientation === 6) when autoFixOrientation is true with mode "oriented-srgb" and ICC warning', async () => {
    const cleanOutputJpeg = buildJpegWithExif({});
    const closeSpy = vi.fn();
    const drawImageSpy = vi.fn();
    const convertToBlobSpy = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array(cleanOutputJpeg)], { type: 'image/jpeg' }));

    class MockOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: drawImageSpy };
      }
      convertToBlob(opts?: ImageEncodeOptions) {
        return convertToBlobSpy(opts);
      }
    }

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 2, height: 2, close: closeSpy })
    );
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

    const orientedWithIcc = buildJpegWithExif({
      orientation: 6,
      make: 'Apple',
      gps: [23.8103, 90.4125],
      icc: true,
    });

    const result = await scrubFile(orientedWithIcc, {
      ...DEFAULT_OPTIONS,
      autoFixOrientation: true,
      preserveIcc: true,
    });

    expect(result.mode).toBe('oriented-srgb');
    expect(result.before.orientation).toBe(6);
    expect(result.after.totalTags).toBe(0);
    expect(result.after.orientation).toBeNull();
    expect(result.after.hasIccProfile).toBe(false);
    expect(result.after.riskLevel).toBe('clean');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/ICC/i);
    expect(result.warnings[0]).toMatch(/sRGB/i);
  });

  it('uses mode "lossless" for oriented JPEG when autoFixOrientation is false, and for Orientation === 1', async () => {
    const oriented = buildJpegWithExif({ orientation: 6, make: 'Nikon' });
    const resNoFix = await scrubFile(oriented, {
      ...DEFAULT_OPTIONS,
      autoFixOrientation: false,
    });
    expect(resNoFix.mode).toBe('lossless');
    expect(resNoFix.after.totalTags).toBe(0);

    const normalOrientation = buildJpegWithExif({ orientation: 1, make: 'Nikon' });
    const resNormal = await scrubFile(normalOrientation, {
      ...DEFAULT_OPTIONS,
      autoFixOrientation: true,
    });
    expect(resNormal.mode).toBe('lossless');
    expect(resNormal.after.totalTags).toBe(0);
  });

  it('returns mode "already-clean" when totalTags === 0 and ICC does not need stripping', async () => {
    const cleanJpeg = buildJpegWithExif({});
    const res1 = await scrubFile(cleanJpeg, DEFAULT_OPTIONS);
    expect(res1.mode).toBe('already-clean');
    expect(res1.cleanBytes).toBe(cleanJpeg);
    expect(res1.after).toEqual(res1.before);
    expect(res1.cleanSize).toBe(cleanJpeg.byteLength);
    expect(res1.warnings).toEqual([]);

    // Has ICC only (totalTags === 0): preserveIcc: true -> already-clean
    const cleanWithIcc = buildJpegWithExif({ icc: true });
    const resKeepIcc = await scrubFile(cleanWithIcc, {
      ...DEFAULT_OPTIONS,
      preserveIcc: true,
    });
    expect(resKeepIcc.mode).toBe('already-clean');
    expect(resKeepIcc.after.hasIccProfile).toBe(true);

    // Has ICC only (totalTags === 0): preserveIcc: false -> lossless scrub to strip ICC
    const resStripIcc = await scrubFile(cleanWithIcc, {
      ...DEFAULT_OPTIONS,
      preserveIcc: false,
    });
    expect(resStripIcc.mode).toBe('lossless');
    expect(resStripIcc.after.hasIccProfile).toBe(false);
    expect(resStripIcc.after.totalTags).toBe(0);
  });

  it('scrubs PDF with mode "pdf-deep" and handles signed/encrypted PDF errors', async () => {
    const pdf = await buildPdfWithDeepMeta({
      author: 'Tamzid',
      title: 'Draft',
      annotAuthor: 'Reviewer',
    });
    const res = await scrubFile(pdf, DEFAULT_OPTIONS);
    expect(res.format).toBe('pdf');
    expect(res.mode).toBe('pdf-deep');
    expect(res.before.totalTags).toBeGreaterThan(0);
    expect(res.after.totalTags).toBe(0);
    expect(res.after.riskLevel).toBe('clean');

    const signedPdf = await buildPdfWithDeepMeta({ author: 'Signer', signed: true });
    await expect(
      scrubFile(signedPdf, { ...DEFAULT_OPTIONS, allowSignedPdfScrub: false })
    ).rejects.toMatchObject({ code: 'signed-confirmation-required' });

    const signedRes = await scrubFile(signedPdf, {
      ...DEFAULT_OPTIONS,
      allowSignedPdfScrub: true,
    });
    expect(signedRes.mode).toBe('pdf-deep');
    expect(signedRes.after.totalTags).toBe(0);
    expect(signedRes.warnings.some((w) => /signature/i.test(w))).toBe(true);

    const encryptedPdf = await buildPdfWithDeepMeta({ encrypted: true });
    await expect(inspectFile(encryptedPdf)).rejects.toThrow(PdfInspectError);
    await expect(inspectFile(encryptedPdf)).rejects.toMatchObject({
      code: 'encrypted',
    });
  });

  it('includes valid public/samples/sample-photo.jpg with GPS + Device metadata that scrubs to clean', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: string) => Uint8Array;
    };
    const sampleBytes = new Uint8Array(readFileSync('public/samples/sample-photo.jpg'));

    expect(detectFormat(sampleBytes)).toBe('jpeg');

    const before = await inspectFile(sampleBytes);
    expect(before.format).toBe('jpeg');
    expect(before.hasGps).toBe(true);
    expect(before.hasIccProfile).toBe(true);
    expect(before.riskLevel).toBe('high');
    expect(before.fields.some((f) => f.category === 'device' && /Apple/i.test(f.value))).toBe(
      true
    );
    expect(
      before.fields.some((f) => f.category === 'device' && /iPhone 15 Pro/i.test(f.value))
    ).toBe(true);

    const res = await scrubFile(sampleBytes, DEFAULT_OPTIONS);
    expect(res.mode).toBe('lossless');
    expect(res.after.totalTags).toBe(0);
    expect(res.after.hasGps).toBe(false);
    expect(res.after.riskLevel).toBe('clean');
  });

  it('detects and scrubs a PDF whose only metadata sits on a /Subtype /Form XObject instead of bypassing as already-clean', async () => {
    const basePdf = await buildPdfWithDeepMeta({});
    const doc = await PDFDocument.load(basePdf, { updateMetadata: false });

    const formContent = new TextEncoder().encode('0 0 50 50 re f');
    const formDict = PDFDict.withContext(doc.context);
    formDict.set(PDFName.of('Type'), PDFName.of('XObject'));
    formDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    formDict.set(PDFName.of('BBox'), doc.context.obj([0, 0, 50, 50]));
    formDict.set(PDFName.of('Length'), PDFNumber.of(formContent.length));
    formDict.set(
      PDFName.of('Metadata'),
      doc.context.register(
        doc.context.stream(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="FormAuthor"/></rdf:RDF></x:xmpmeta>',
          { Type: 'Metadata', Subtype: 'XML' }
        )
      )
    );
    formDict.set(
      PDFName.of('PieceInfo'),
      doc.context.obj({ Illustrator: { LastModified: PDFString.of('D:20260101000000Z') } })
    );

    const formRef = doc.context.register(PDFRawStream.of(formDict, formContent));
    doc.getPages()[0]!.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm1: formRef } }));

    const pdfBytes = await doc.save({ useObjectStreams: false });
    const inspected = await inspectFile(pdfBytes);
    expect(inspected.totalTags).toBeGreaterThan(0);

    const res = await scrubFile(pdfBytes, DEFAULT_OPTIONS);
    expect(res.mode).toBe('pdf-deep');
    expect(res.before.totalTags).toBeGreaterThan(0);
    expect(res.after.totalTags).toBe(0);
    expect(res.after.riskLevel).toBe('clean');
  });
});

describe('ScrubWorkerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back cleanly to direct execution when Worker is unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const client = new ScrubWorkerClient();

    const jpeg = buildJpegWithExif({ gps: [23.8103, 90.4125], make: 'Apple' });
    const report = await client.inspect(jpeg);
    expect(report.hasGps).toBe(true);

    const result = await client.scrub(jpeg, DEFAULT_OPTIONS);
    expect(result.mode).toBe('lossless');
    expect(result.after.totalTags).toBe(0);

    client.dispose();
  });

  it('handles worker postMessage responses, main-thread Safari orientation fallback, and error rehydration', async () => {
    const cleanOutputJpeg = buildJpegWithExif({});
    const closeSpy = vi.fn();
    const drawImageSpy = vi.fn();
    const toBlobSpy = vi.fn((cb: (blob: Blob | null) => void) => {
      cb(new Blob([new Uint8Array(cleanOutputJpeg)], { type: 'image/jpeg' }));
    });
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: drawImageSpy }),
          toBlob: toBlobSpy,
        } as unknown as HTMLCanvasElement;
      }
      return origCreateElement(tagName);
    });
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 2, height: 2, close: closeSpy })
    );

    type WorkerHandler = (msg: { data: unknown }) => void;
    let onmessageHandler: WorkerHandler | null = null;
    const terminateSpy = vi.fn();
    const postMessageSpy = vi.fn((payload: Record<string, unknown>) => {
      const id = payload.id as number;
      if (payload.type === 'inspect') {
        const bytes = payload.bytes as Uint8Array;
        queueMicrotask(async () => {
          try {
            const report = await inspectFile(bytes);
            onmessageHandler?.({ data: { id, type: 'inspect-result', report } });
          } catch (err) {
            const e = err as Error & { code?: string };
            onmessageHandler?.({
              data: {
                id,
                type: 'error',
                error: { name: e.name, code: e.code, message: e.message },
              },
            });
          }
        });
      } else if (payload.type === 'scrub') {
        const bytes = payload.bytes as Uint8Array;
        const options = payload.options as ScrubOptions;
        queueMicrotask(async () => {
          try {
            const before = await inspectFile(bytes);
            if (
              before.format === 'jpeg' &&
              before.orientation !== null &&
              before.orientation >= 2 &&
              before.orientation <= 8 &&
              options.autoFixOrientation
            ) {
              onmessageHandler?.({
                data: { id, type: 'needs-main-thread-orientation', before },
              });
              return;
            }
            const result = await scrubFile(bytes, options);
            onmessageHandler?.({ data: { id, type: 'scrub-result', result } });
          } catch (err) {
            const e = err as Error & { code?: string };
            onmessageHandler?.({
              data: {
                id,
                type: 'error',
                error: { name: e.name, code: e.code, message: e.message },
              },
            });
          }
        });
      }
    });

    class MockWorker {
      set onmessage(fn: WorkerHandler | null) {
        onmessageHandler = fn;
      }
      get onmessage() {
        return onmessageHandler;
      }
      onerror: ((ev: unknown) => void) | null = null;
      onmessageerror: ((ev: unknown) => void) | null = null;
      postMessage = postMessageSpy;
      terminate = terminateSpy;
    }

    vi.stubGlobal('Worker', MockWorker);

    const client = new ScrubWorkerClient(() => new MockWorker() as unknown as Worker);

    // 1. Normal inspect via worker
    const jpeg = buildJpegWithExif({ make: 'Fuji', gps: [10, 20] });
    const inspected: MetadataReport = await client.inspect(jpeg);
    expect(inspected.hasGps).toBe(true);

    // 2. Safari orientation fallback from worker -> main thread
    const oriented = buildJpegWithExif({ orientation: 6, icc: true, make: 'Apple' });
    const scrubRes: ScrubResult = await client.scrub(oriented, {
      ...DEFAULT_OPTIONS,
      autoFixOrientation: true,
      preserveIcc: true,
    });
    expect(scrubRes.mode).toBe('oriented-srgb');
    expect(scrubRes.after.totalTags).toBe(0);
    expect(scrubRes.warnings.some((w) => /ICC/i.test(w) && /sRGB/i.test(w))).toBe(true);
    expect(toBlobSpy).toHaveBeenCalledTimes(1);

    // 3. Rehydrate UnsupportedFormatError, PdfInspectError, PdfScrubError
    await expect(client.inspect(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      UnsupportedFormatError
    );

    const encryptedPdf = await buildPdfWithDeepMeta({ encrypted: true });
    await expect(client.inspect(encryptedPdf)).rejects.toBeInstanceOf(PdfInspectError);
    await expect(client.inspect(encryptedPdf)).rejects.toMatchObject({ code: 'encrypted' });

    const signedPdf = await buildPdfWithDeepMeta({ author: 'Signer', signed: true });
    await expect(
      client.scrub(signedPdf, { ...DEFAULT_OPTIONS, allowSignedPdfScrub: false })
    ).rejects.toBeInstanceOf(PdfScrubError);
    await expect(
      client.scrub(signedPdf, { ...DEFAULT_OPTIONS, allowSignedPdfScrub: false })
    ).rejects.toMatchObject({ code: 'signed-confirmation-required' });

    client.dispose();
    expect(terminateSpy).toHaveBeenCalledTimes(1);
  });

  it('scrub.worker.ts handles inspect, scrub, Safari OffscreenCanvas fallback, and error serialization', async () => {
    const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
    const origPostMessage = globalThis.postMessage;
    const origOnMessage = (globalThis as { onmessage?: unknown }).onmessage;

    vi.stubGlobal('postMessage', (message: unknown, transfer?: Transferable[]) => {
      posted.push({ message, transfer });
    });

    try {
      await import('../src/workers/scrub.worker');
      const handler = (globalThis as unknown as {
        onmessage: (ev: { data: unknown }) => Promise<void>;
      }).onmessage;
      expect(typeof handler).toBe('function');

      // 1. Inspect
      const jpeg = buildJpegWithExif({ gps: [23.8103, 90.4125], make: 'Apple' });
      await handler({ data: { id: 1, type: 'inspect', bytes: jpeg } });
      expect(posted.at(-1)?.message).toMatchObject({
        id: 1,
        type: 'inspect-result',
        report: { format: 'jpeg', hasGps: true },
      });

      // 2. Orientation 6 without OffscreenCanvas -> needs-main-thread-orientation
      vi.stubGlobal('OffscreenCanvas', undefined);
      const oriented = buildJpegWithExif({ orientation: 6, icc: true, make: 'Apple' });
      await handler({
        data: { id: 2, type: 'scrub', bytes: oriented, options: DEFAULT_OPTIONS },
      });
      expect(posted.at(-1)?.message).toMatchObject({
        id: 2,
        type: 'needs-main-thread-orientation',
        before: { format: 'jpeg', orientation: 6, hasIccProfile: true },
      });

      // 3. Error serialization for unsupported format
      await handler({
        data: { id: 3, type: 'inspect', bytes: new Uint8Array([0, 1, 2]) },
      });
      expect(posted.at(-1)?.message).toMatchObject({
        id: 3,
        type: 'error',
        error: {
          name: 'UnsupportedFormatError',
          code: 'unsupported-format',
        },
      });
    } finally {
      vi.stubGlobal('postMessage', origPostMessage);
      (globalThis as { onmessage?: unknown }).onmessage = origOnMessage;
    }
  });

  it('terminates crashed worker on onerror and spawns a fresh worker on subsequent calls', async () => {
    const terminateFirst = vi.fn();
    const terminateSecond = vi.fn();
    let createdCount = 0;

    class MockWorker {}
    vi.stubGlobal('Worker', MockWorker);

    const worker1 = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev: ErrorEvent) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          worker1.onerror?.({ message: 'Worker crashed fatally' } as ErrorEvent);
        });
      }),
      terminate: terminateFirst,
    };

    const worker2 = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev: ErrorEvent) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn((payload: Record<string, unknown>) => {
        const id = payload.id as number;
        const bytes = payload.bytes as Uint8Array;
        queueMicrotask(async () => {
          const report = await inspectFile(bytes);
          worker2.onmessage?.({ data: { id, type: 'inspect-result', report } });
        });
      }),
      terminate: terminateSecond,
    };

    const factory = vi.fn(() => {
      createdCount++;
      return (createdCount === 1 ? worker1 : worker2) as unknown as Worker;
    });

    const client = new ScrubWorkerClient(factory);
    const jpeg = buildJpegWithExif({ gps: [23.8103, 90.4125], make: 'Apple' });

    await expect(client.inspect(jpeg)).rejects.toThrow('Worker crashed fatally');
    expect(terminateFirst).toHaveBeenCalledTimes(1);

    const report = await client.inspect(jpeg);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(report.hasGps).toBe(true);

    client.dispose();
    expect(terminateSecond).toHaveBeenCalledTimes(1);
  });

  it('cleans up pending map and rejects when worker.postMessage throws synchronously', async () => {
    class MockWorker {}
    vi.stubGlobal('Worker', MockWorker);

    const mockWorker = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev: ErrorEvent) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn(() => {
        throw new Error('DataCloneError: cannot clone payload');
      }),
      terminate: vi.fn(),
    };

    const client = new ScrubWorkerClient(() => mockWorker as unknown as Worker);
    const jpeg = buildJpegWithExif({ make: 'Apple' });

    await expect(client.inspect(jpeg)).rejects.toThrow('DataCloneError: cannot clone payload');
    await expect(client.scrub(jpeg, DEFAULT_OPTIONS)).rejects.toThrow(
      'DataCloneError: cannot clone payload'
    );

    const pendingSize = (client as unknown as { pending: Map<number, unknown> }).pending.size;
    expect(pendingSize).toBe(0);
    client.dispose();
  });
});
