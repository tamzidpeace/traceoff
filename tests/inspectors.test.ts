import { describe, it, expect } from 'vitest';
import { inspectImage } from '../src/core/inspector/inspectImage';
import { inspectPdf, PdfInspectError } from '../src/core/inspector/inspectPdf';
import { classifyMetadataKey, hasGpsField } from '../src/core/inspector/shared';
import {
  buildJpegWithExif,
  buildMinimalExifTiff,
  buildPngWithMeta,
  buildWebpWithMeta,
  buildPdfWithDeepMeta,
} from './helpers/fixtures';

describe('inspectImage', () => {
  it('detects GPS, device Make, Orientation, and ICC profile in JPEG without counting ICC as tracking tag', async () => {
    const jpeg = buildJpegWithExif({
      gps: [23.8103, 90.4125],
      make: 'Apple',
      orientation: 6,
      icc: true,
    });

    const report = await inspectImage(jpeg, 'jpeg');

    expect(report.format).toBe('jpeg');
    expect(report.hasGps).toBe(true);
    expect(report.riskLevel).toBe('high');
    expect(report.orientation).toBe(6);
    expect(report.hasIccProfile).toBe(true);
    expect(report.isSignedPdf).toBe(false);
    expect(report.embeddedImageWithMetaCount).toBe(0);
    expect(report.totalTags).toBeGreaterThan(0);

    const keys = report.fields.map((f) => f.key.toLowerCase());
    expect(keys.some((k) => k.includes('gps') || k.includes('latitude'))).toBe(true);
    expect(keys.some((k) => k === 'make')).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Apple'))).toBe(true);
    expect(report.fields.some((f) => f.category === 'location' && f.sensitive)).toBe(true);
    expect(report.fields.some((f) => f.category === 'device')).toBe(true);
  });

  it('reports JPEG COM comments and XMP metadata even when no EXIF is present', async () => {
    const jpeg = buildJpegWithExif({
      comment: 'Exported from Darktable',
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Arafat"/></rdf:RDF></x:xmpmeta>',
    });

    const report = await inspectImage(jpeg, 'jpeg');
    expect(report.hasGps).toBe(false);
    expect(report.riskLevel).toBe('medium');
    expect(report.fields.some((f) => f.value.includes('Exported from Darktable'))).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Arafat') || f.key.toLowerCase().includes('xmp'))).toBe(true);
  });

  it('treats standalone ICC profile without tracking metadata as clean', async () => {
    const jpeg = buildJpegWithExif({ icc: true });
    const report = await inspectImage(jpeg, 'jpeg');

    expect(report.hasIccProfile).toBe(true);
    expect(report.totalTags).toBe(0);
    expect(report.fields).toHaveLength(0);
    expect(report.riskLevel).toBe('clean');
  });

  it('detects PNG tEXt Software chunk as medium risk', async () => {
    const png = buildPngWithMeta({ text: { Software: 'Photoshop' } });
    const report = await inspectImage(png, 'png');

    expect(report.format).toBe('png');
    expect(report.hasGps).toBe(false);
    expect(report.riskLevel).toBe('medium');
    expect(report.totalTags).toBeGreaterThan(0);
    expect(
      report.fields.some(
        (f) => f.key.toLowerCase().includes('software') && f.value.includes('Photoshop')
      )
    ).toBe(true);
  });

  it('detects PNG eXIf GPS, zTXt, iTXt, tIME, and iCCP without counting iCCP as tracking tag', async () => {
    const png = buildPngWithMeta({
      exif: buildMinimalExifTiff({ gps: [23.8103, 90.4125], make: 'Canon' }),
      ztxt: { Comment: 'Hidden compressed note' },
      itxt: { Author: 'Alice' },
      time: new Date('2026-05-01T12:00:00Z'),
      iccp: true,
    });
    const report = await inspectImage(png, 'png');

    expect(report.hasGps).toBe(true);
    expect(report.riskLevel).toBe('high');
    expect(report.hasIccProfile).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Canon'))).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Hidden compressed note'))).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Alice'))).toBe(true);
    expect(report.fields.some((f) => f.key.toLowerCase().includes('time'))).toBe(true);

    const iccOnlyPng = buildPngWithMeta({ iccp: true });
    const iccOnlyReport = await inspectImage(iccOnlyPng, 'png');
    expect(iccOnlyReport.hasIccProfile).toBe(true);
    expect(iccOnlyReport.totalTags).toBe(0);
    expect(iccOnlyReport.riskLevel).toBe('clean');
  });

  it('detects WebP EXIF (GPS), XMP, and ICCP chunks', async () => {
    const webp = buildWebpWithMeta({
      exif: buildMinimalExifTiff({ gps: [23.8103, 90.4125], make: 'Sony' }),
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Lightroom"/></rdf:RDF></x:xmpmeta>',
      iccp: true,
    });

    const report = await inspectImage(webp, 'webp');

    expect(report.format).toBe('webp');
    expect(report.hasGps).toBe(true);
    expect(report.riskLevel).toBe('high');
    expect(report.hasIccProfile).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Sony'))).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Lightroom') || f.key.toLowerCase().includes('xmp'))).toBe(true);

    const iccOnlyWebp = buildWebpWithMeta({ iccp: true });
    const iccOnlyReport = await inspectImage(iccOnlyWebp, 'webp');
    expect(iccOnlyReport.hasIccProfile).toBe(true);
    expect(iccOnlyReport.totalTags).toBe(0);
    expect(iccOnlyReport.riskLevel).toBe('clean');
  });

  it('falls back to PNG eXIf chunk scanning when eXIf has Exif\\0\\0 prefix', async () => {
    const tiff = buildMinimalExifTiff({ gps: [23.8103, 90.4125], make: 'Nikon' });
    const prefixed = new Uint8Array(6 + tiff.length);
    prefixed.set(new TextEncoder().encode('Exif\0\0'), 0);
    prefixed.set(tiff, 6);

    const pngBase = buildPngWithMeta({ text: { Comment: 'test' } });
    const ihdrEnd = 8 + 4 + 4 + 13 + 4; // sig + IHDR
    const typeAndData = new Uint8Array(4 + prefixed.length);
    typeAndData.set(new TextEncoder().encode('eXIf'), 0);
    typeAndData.set(prefixed, 4);
    const { crc32 } = await import('./helpers/fixtures');
    const c = crc32(typeAndData);
    const chunk = new Uint8Array(12 + prefixed.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, prefixed.length, false);
    chunk.set(typeAndData, 4);
    dv.setUint32(8 + prefixed.length, c, false);

    const pngWithPrefixedExif = new Uint8Array(pngBase.length + chunk.length);
    pngWithPrefixedExif.set(pngBase.subarray(0, ihdrEnd), 0);
    pngWithPrefixedExif.set(chunk, ihdrEnd);
    pngWithPrefixedExif.set(pngBase.subarray(ihdrEnd), ihdrEnd + chunk.length);

    const report = await inspectImage(pngWithPrefixedExif, 'png');
    expect(report.hasGps).toBe(true);
    expect(report.riskLevel).toBe('high');
    expect(report.fields.some((f) => f.value.includes('Nikon'))).toBe(true);
  });
});

describe('inspectPdf', () => {
  it('inspects Info dict, XMP, Annotation author, and embedded JPEG GPS/Make', async () => {
    const embeddedJpeg = buildJpegWithExif({
      gps: [23.8103, 90.4125],
      make: 'Apple',
    });
    const pdf = await buildPdfWithDeepMeta({
      author: 'Arafat',
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Arafat"/></rdf:RDF></x:xmpmeta>',
      annotAuthor: 'Reviewer',
      embeddedJpeg,
    });

    const report = await inspectPdf(pdf);

    expect(report.format).toBe('pdf');
    expect(report.riskLevel).toBe('high');
    expect(report.hasGps).toBe(true);
    expect(report.embeddedImageWithMetaCount).toBe(1);
    expect(report.isSignedPdf).toBe(false);
    expect(report.totalTags).toBeGreaterThan(0);

    expect(report.fields.some((f) => f.value.includes('Arafat') && f.category === 'author')).toBe(true);
    expect(report.fields.some((f) => f.key.toLowerCase().includes('xmp'))).toBe(true);
    expect(report.fields.some((f) => f.value.includes('Reviewer'))).toBe(true);
    expect(report.fields.some((f) => f.category === 'pdf-embedded' && f.value.includes('Apple'))).toBe(true);
    expect(
      report.fields.some(
        (f) => f.category === 'location' || (f.category === 'pdf-embedded' && f.key.toLowerCase().includes('gps'))
      )
    ).toBe(true);
  });

  it('sets isSignedPdf: true when PDF has /AcroForm /Sig or /ByteRange', async () => {
    const signedPdf = await buildPdfWithDeepMeta({ signed: true });
    const report = await inspectPdf(signedPdf);

    expect(report.isSignedPdf).toBe(true);
  });

  it('throws PdfInspectError with code encrypted on encrypted PDF bytes', async () => {
    const encryptedPdf = await buildPdfWithDeepMeta({ encrypted: true });

    await expect(inspectPdf(encryptedPdf)).rejects.toThrow(PdfInspectError);
    await expect(inspectPdf(encryptedPdf)).rejects.toMatchObject({
      code: 'encrypted',
    });
  });

  it('reports clean when PDF has no metadata', async () => {
    const cleanPdf = await buildPdfWithDeepMeta({});
    const report = await inspectPdf(cleanPdf);

    expect(report.riskLevel).toBe('clean');
    expect(report.hasGps).toBe(false);
    expect(report.totalTags).toBe(0);
    expect(report.embeddedImageWithMetaCount).toBe(0);
    expect(report.isSignedPdf).toBe(false);
  });

  it('detects page-level XMP and PieceInfo metadata', async () => {
    const pdf = await buildPdfWithDeepMeta({
      pageXmp:
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="InDesign"/></rdf:RDF></x:xmpmeta>',
      pieceInfo: true,
    });
    const report = await inspectPdf(pdf);

    expect(report.riskLevel).toBe('medium');
    expect(report.fields.some((f) => f.value.includes('InDesign'))).toBe(true);
    expect(report.fields.some((f) => f.key.toLowerCase().includes('pieceinfo'))).toBe(true);
  });

  it('throws PdfInspectError with code invalid on corrupt PDF bytes', async () => {
    const invalid = new TextEncoder().encode('not-a-pdf-file');

    await expect(inspectPdf(invalid)).rejects.toThrow(PdfInspectError);
    await expect(inspectPdf(invalid)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('extracts standard nested RDF XMP elements (dc:creator/rdf:Seq/rdf:li) and raises hasGps on XMP-only GPS', async () => {
    const rdfXmp = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/">',
      '      <dc:creator><rdf:Seq><rdf:li>Tamzid Peace</rdf:li></rdf:Seq></dc:creator>',
      '      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Secret Draft</rdf:li></rdf:Alt></dc:title>',
      '      <exif:GPSLatitude>23,48.618N</exif:GPSLatitude>',
      '      <exif:GPSLongitude>90,24.750E</exif:GPSLongitude>',
      '    </rdf:Description>',
      '  </rdf:RDF>',
      '</x:xmpmeta>',
    ].join('\n');

    const pdf = await buildPdfWithDeepMeta({ xmp: rdfXmp });
    const pdfReport = await inspectPdf(pdf);

    expect(pdfReport.hasGps).toBe(true);
    expect(pdfReport.riskLevel).toBe('high');
    expect(
      pdfReport.fields.some(
        (f) => f.key.includes('dc:creator') && f.value.includes('Tamzid Peace')
      )
    ).toBe(true);
    expect(
      pdfReport.fields.some(
        (f) => f.key.includes('dc:title') && f.value.includes('Secret Draft')
      )
    ).toBe(true);

    const webp = buildWebpWithMeta({ xmp: rdfXmp });
    const webpReport = await inspectImage(webp, 'webp');
    expect(webpReport.hasGps).toBe(true);
    expect(webpReport.riskLevel).toBe('high');
    expect(
      webpReport.fields.some(
        (f) => f.key === 'xmp:dc:creator' && f.value === 'Tamzid Peace'
      )
    ).toBe(true);
  });
});

describe('metadata classification & GPS detection helpers', () => {
  it('strips namespace prefix before matching device and non-sensitive technical keys', () => {
    expect(classifyMetadataKey('tiff:Make')).toEqual({ category: 'device', sensitive: true });
    expect(classifyMetadataKey('exif:LensModel')).toEqual({ category: 'device', sensitive: true });
    expect(classifyMetadataKey('tiff:Orientation')).toEqual({
      category: 'other',
      sensitive: false,
    });
  });

  it('does not flag GPSVersionID or GPSStatus as coordinate GPS leaks', () => {
    expect(
      hasGpsField([
        { key: 'GPSVersionID', label: 'GPS Version ID', value: '2.3.0.0', category: 'location', sensitive: true },
        { key: 'GPSStatus', label: 'GPS Status', value: 'A', category: 'location', sensitive: true },
      ])
    ).toBe(false);

    expect(
      hasGpsField([
        { key: 'GPSLatitude', label: 'GPS Latitude', value: '23.8', category: 'location', sensitive: true },
      ])
    ).toBe(true);
    expect(
      hasGpsField([
        { key: 'exif:GPSPosition', label: 'GPS Position', value: '23.8, 90.4', category: 'location', sensitive: true },
      ])
    ).toBe(true);
  });
});
