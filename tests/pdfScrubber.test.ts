import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString } from 'pdf-lib';
import { inspectImage } from '../src/core/inspector/inspectImage';
import { inspectPdf, PdfInspectError } from '../src/core/inspector/inspectPdf';
import { PdfScrubError, scrubPdfDeep } from '../src/core/scrubbers/pdfScrubber';
import { buildJpegWithExif, buildPdfWithDeepMeta } from './helpers/fixtures';

function findEmbeddedJpegStreams(doc: PDFDocument): PDFRawStream[] {
  const streams: PDFRawStream[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (obj.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode')) {
      streams.push(obj);
    }
  }
  return streams;
}

describe('scrubPdfDeep', () => {
  it('clears all Info fields including default pdf-lib Producer and custom Info keys', async () => {
    const pdfBytes = await buildPdfWithDeepMeta({
      title: 'Confidential Q4 Plan',
      author: 'Arafat',
      subject: 'Internal Strategy',
      keywords: ['secret', 'roadmap'],
      creator: 'Adobe Acrobat Pro',
      producer: 'macOS Quartz PDFContext',
      creationDate: new Date('2026-01-15T10:30:00Z'),
      modificationDate: new Date('2026-02-20T14:45:00Z'),
    });

    // Add a custom non-standard Info key as well
    const loaded = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    const infoDict = loaded.context.lookup(loaded.context.trailerInfo.Info);
    if (infoDict instanceof PDFDict) {
      infoDict.set(PDFName.of('CompanySecret'), PDFString.of('Project-X'));
    }
    const pdfWithCustomInfo = await loaded.save({ useObjectStreams: false });

    const before = await inspectPdf(pdfWithCustomInfo);
    expect(before.totalTags).toBeGreaterThanOrEqual(9);

    const { cleanBytes, warnings } = await scrubPdfDeep(pdfWithCustomInfo, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });

    expect(warnings).toEqual([]);

    const afterReport = await inspectPdf(cleanBytes);
    expect(afterReport.totalTags).toBe(0);
    expect(afterReport.riskLevel).toBe('clean');

    const cleanDoc = await PDFDocument.load(cleanBytes, { updateMetadata: false });
    expect(cleanDoc.context.trailerInfo.Info).toBeUndefined();
    expect(cleanDoc.getTitle()).toBeUndefined();
    expect(cleanDoc.getAuthor()).toBeUndefined();
    expect(cleanDoc.getSubject()).toBeUndefined();
    expect(cleanDoc.getKeywords()).toBeUndefined();
    expect(cleanDoc.getCreator()).toBeUndefined();
    expect(cleanDoc.getProducer()).toBeUndefined();
    expect(cleanDoc.getCreationDate()).toBeUndefined();
    expect(cleanDoc.getModificationDate()).toBeUndefined();
  });

  it('deletes catalog and page /Metadata (XMP) and /PieceInfo', async () => {
    const rdfXmp = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/">',
      '      <dc:creator><rdf:Seq><rdf:li>Tamzid Peace</rdf:li></rdf:Seq></dc:creator>',
      '      <exif:GPSLatitude>23,48.618N</exif:GPSLatitude>',
      '      <exif:GPSLongitude>90,24.750E</exif:GPSLongitude>',
      '    </rdf:Description>',
      '  </rdf:RDF>',
      '</x:xmpmeta>',
    ].join('\n');

    const pdfBytes = await buildPdfWithDeepMeta({
      xmp: rdfXmp,
      pageXmp:
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="InDesign"/></rdf:RDF></x:xmpmeta>',
      pieceInfo: true,
    });

    const before = await inspectPdf(pdfBytes);
    expect(before.hasGps).toBe(true);
    expect(before.totalTags).toBeGreaterThan(0);

    const { cleanBytes, warnings } = await scrubPdfDeep(pdfBytes, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });

    expect(warnings).toEqual([]);

    const after = await inspectPdf(cleanBytes);
    expect(after.totalTags).toBe(0);
    expect(after.hasGps).toBe(false);
    expect(after.riskLevel).toBe('clean');

    const cleanDoc = await PDFDocument.load(cleanBytes, { updateMetadata: false });
    expect(cleanDoc.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(cleanDoc.catalog.get(PDFName.of('PieceInfo'))).toBeUndefined();
    for (const page of cleanDoc.getPages()) {
      expect(page.node.get(PDFName.of('Metadata'))).toBeUndefined();
      expect(page.node.get(PDFName.of('PieceInfo'))).toBeUndefined();
    }
  });

  it('clears /Annots and nested /Popup author (/T), subject (/Subj), /CreationDate, and /M', async () => {
    const pdfBytes = await buildPdfWithDeepMeta({
      annotAuthor: 'Reviewer One',
      annotSubject: 'Confidential Feedback',
    });

    // Attach a /Popup annotation with its own metadata and a cyclic /Parent back-reference
    const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    const page = doc.getPages()[0]!;
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    expect(annots).toBeInstanceOf(PDFArray);
    const parentRef = (annots as PDFArray).get(0);
    const parentDict = doc.context.lookup(parentRef) as PDFDict;

    const popupDict = PDFDict.withContext(doc.context);
    popupDict.set(PDFName.of('Type'), PDFName.of('Annot'));
    popupDict.set(PDFName.of('Subtype'), PDFName.of('Popup'));
    popupDict.set(PDFName.of('T'), PDFString.of('Popup Author'));
    popupDict.set(PDFName.of('Subj'), PDFString.of('Popup Subject'));
    popupDict.set(PDFName.of('CreationDate'), PDFString.of('D:20260103000000Z'));
    popupDict.set(PDFName.of('M'), PDFString.of('D:20260104000000Z'));
    popupDict.set(PDFName.of('Parent'), parentRef);
    const popupRef = doc.context.register(popupDict);
    parentDict.set(PDFName.of('Popup'), popupRef);

    const bytesWithPopup = await doc.save({ useObjectStreams: false });

    const before = await inspectPdf(bytesWithPopup);
    expect(before.fields.some((f) => f.value === 'Reviewer One')).toBe(true);
    expect(before.fields.some((f) => f.value === 'Confidential Feedback')).toBe(true);
    expect(before.fields.some((f) => f.value === 'Popup Author')).toBe(true);

    const { cleanBytes } = await scrubPdfDeep(bytesWithPopup, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });

    const after = await inspectPdf(cleanBytes);
    expect(after.totalTags).toBe(0);
    expect(after.riskLevel).toBe('clean');

    // Also verify scrubPdfDeep handles cyclic /Popup references safely without infinite recursion
    popupDict.set(PDFName.of('Popup'), parentRef);
    const cyclicBytes = await doc.save({ useObjectStreams: false });
    const { cleanBytes: cleanCyclicBytes } = await scrubPdfDeep(cyclicBytes, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });
    const cleanCyclicDoc = await PDFDocument.load(cleanCyclicBytes, { updateMetadata: false });
    expect(cleanCyclicDoc.getPageCount()).toBe(1);
  });

  it('scrubs embedded /DCTDecode JPEG XObject EXIF/GPS/XMP while keeping PDF valid and visual attributes intact', async () => {
    const embeddedJpeg = buildJpegWithExif({
      gps: [23.8103, 90.4125],
      make: 'Apple',
      model: 'iPhone 16 Pro',
      icc: true,
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="CameraOwner"/></rdf:RDF></x:xmpmeta>',
    });

    const pdfBytes = await buildPdfWithDeepMeta({
      author: 'Arafat',
      embeddedJpeg,
    });

    // Also attach /Metadata and /PieceInfo onto the image XObject itself
    const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    const imgStreams = findEmbeddedJpegStreams(doc);
    expect(imgStreams).toHaveLength(1);
    const imgStream = imgStreams[0]!;
    imgStream.dict.set(
      PDFName.of('Metadata'),
      doc.context.register(
        doc.context.stream(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="ImageOwner"/></rdf:RDF></x:xmpmeta>',
          { Type: 'Metadata', Subtype: 'XML' }
        )
      )
    );
    imgStream.dict.set(
      PDFName.of('PieceInfo'),
      doc.context.obj({ Photoshop: { LastModified: PDFString.of('D:20260101000000Z') } })
    );
    const enrichedPdf = await doc.save({ useObjectStreams: false });

    const before = await inspectPdf(enrichedPdf);
    expect(before.hasGps).toBe(true);
    expect(before.embeddedImageWithMetaCount).toBe(1);

    // 1) Scrub with preserveIcc: true
    const { cleanBytes: cleanWithIcc } = await scrubPdfDeep(enrichedPdf, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });

    const reportWithIcc = await inspectPdf(cleanWithIcc);
    expect(reportWithIcc.totalTags).toBe(0);
    expect(reportWithIcc.hasGps).toBe(false);
    expect(reportWithIcc.embeddedImageWithMetaCount).toBe(0);
    expect(reportWithIcc.riskLevel).toBe('clean');

    const cleanDoc = await PDFDocument.load(cleanWithIcc, { updateMetadata: false });
    expect(cleanDoc.getPageCount()).toBe(1);
    const scrubbedStreams = findEmbeddedJpegStreams(cleanDoc);
    expect(scrubbedStreams).toHaveLength(1);
    const scrubbedImg = scrubbedStreams[0]!;
    expect(scrubbedImg.dict.get(PDFName.of('Width'))).toBeDefined();
    expect(scrubbedImg.dict.get(PDFName.of('Height'))).toBeDefined();
    expect(scrubbedImg.dict.get(PDFName.of('ColorSpace'))).toBeDefined();
    expect(scrubbedImg.dict.get(PDFName.of('BitsPerComponent'))).toBeDefined();
    expect(scrubbedImg.dict.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(scrubbedImg.dict.get(PDFName.of('PieceInfo'))).toBeUndefined();

    const embeddedReportWithIcc = await inspectImage(scrubbedImg.getContents(), 'jpeg');
    expect(embeddedReportWithIcc.totalTags).toBe(0);
    expect(embeddedReportWithIcc.hasIccProfile).toBe(true);

    // 2) Scrub with preserveIcc: false
    const { cleanBytes: cleanNoIcc } = await scrubPdfDeep(enrichedPdf, {
      preserveIcc: false,
      allowSignedPdfScrub: false,
    });
    const cleanDocNoIcc = await PDFDocument.load(cleanNoIcc, { updateMetadata: false });
    const scrubbedStreamsNoIcc = findEmbeddedJpegStreams(cleanDocNoIcc);
    expect(scrubbedStreamsNoIcc).toHaveLength(1);
    const embeddedReportNoIcc = await inspectImage(scrubbedStreamsNoIcc[0]!.getContents(), 'jpeg');
    expect(embeddedReportNoIcc.totalTags).toBe(0);
    expect(embeddedReportNoIcc.hasIccProfile).toBe(false);
  });

  it('rejects signed PDF when allowSignedPdfScrub is false, and scrubs with warning when true', async () => {
    const signedPdf = await buildPdfWithDeepMeta({
      author: 'Signer',
      signed: true,
    });

    await expect(
      scrubPdfDeep(signedPdf, {
        preserveIcc: true,
        allowSignedPdfScrub: false,
      })
    ).rejects.toThrow(PdfScrubError);

    await expect(
      scrubPdfDeep(signedPdf, {
        preserveIcc: true,
        allowSignedPdfScrub: false,
      })
    ).rejects.toMatchObject({
      code: 'signed-confirmation-required',
    });

    const { cleanBytes, warnings } = await scrubPdfDeep(signedPdf, {
      preserveIcc: true,
      allowSignedPdfScrub: true,
    });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /signature/i.test(w) && /invalidat/i.test(w))).toBe(true);

    const after = await inspectPdf(cleanBytes);
    expect(after.totalTags).toBe(0);
    expect(after.riskLevel).toBe('clean');
  });

  it('rejects encrypted PDF with PdfInspectError("encrypted") and corrupt bytes with "invalid"', async () => {
    const encryptedPdf = await buildPdfWithDeepMeta({ encrypted: true });

    await expect(
      scrubPdfDeep(encryptedPdf, {
        preserveIcc: true,
        allowSignedPdfScrub: false,
      })
    ).rejects.toThrow(PdfInspectError);

    await expect(
      scrubPdfDeep(encryptedPdf, {
        preserveIcc: true,
        allowSignedPdfScrub: false,
      })
    ).rejects.toMatchObject({
      code: 'encrypted',
    });

    const corruptBytes = new TextEncoder().encode('not-a-pdf');
    await expect(
      scrubPdfDeep(corruptBytes, {
        preserveIcc: true,
        allowSignedPdfScrub: false,
      })
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('preserves malformed or abbreviated /DCTDecode stream with warning instead of aborting scrub', async () => {
    const basePdf = await buildPdfWithDeepMeta({ author: 'Alice' });
    const doc = await PDFDocument.load(basePdf, { updateMetadata: false });

    const abbreviatedJpeg = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const imgDict = PDFDict.withContext(doc.context);
    imgDict.set(PDFName.of('Type'), PDFName.of('XObject'));
    imgDict.set(PDFName.of('Subtype'), PDFName.of('Image'));
    imgDict.set(PDFName.of('Width'), PDFNumber.of(2));
    imgDict.set(PDFName.of('Height'), PDFNumber.of(2));
    imgDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));
    imgDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    imgDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    imgDict.set(PDFName.of('Length'), PDFNumber.of(abbreviatedJpeg.length));
    const imgRef = doc.context.register(PDFRawStream.of(imgDict, abbreviatedJpeg));

    const page = doc.getPages()[0]!;
    const resources = doc.context.obj({ XObject: { Im1: imgRef } });
    page.node.set(PDFName.of('Resources'), resources);

    const pdfBytes = await doc.save({ useObjectStreams: false });

    const { cleanBytes, warnings } = await scrubPdfDeep(pdfBytes, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/embedded JPEG stream #1/i);
    expect(warnings[0]).toMatch(/preserved/i);

    const cleanDoc = await PDFDocument.load(cleanBytes, { updateMetadata: false });
    expect(cleanDoc.context.trailerInfo.Info).toBeUndefined();
    const preservedStreams = findEmbeddedJpegStreams(cleanDoc);
    expect(preservedStreams).toHaveLength(1);
    expect(Array.from(preservedStreams[0]!.getContents())).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('deletes /Metadata and /PieceInfo from /Subtype /Form XObjects', async () => {
    const basePdf = await buildPdfWithDeepMeta({});
    const doc = await PDFDocument.load(basePdf, { updateMetadata: false });

    const formContent = new TextEncoder().encode('0 0 100 100 re f');
    const formDict = PDFDict.withContext(doc.context);
    formDict.set(PDFName.of('Type'), PDFName.of('XObject'));
    formDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    formDict.set(PDFName.of('BBox'), doc.context.obj([0, 0, 100, 100]));
    formDict.set(PDFName.of('Length'), PDFNumber.of(formContent.length));
    formDict.set(
      PDFName.of('Metadata'),
      doc.context.register(
        doc.context.stream(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="IllustratorUser"/></rdf:RDF></x:xmpmeta>',
          { Type: 'Metadata', Subtype: 'XML' }
        )
      )
    );
    formDict.set(
      PDFName.of('PieceInfo'),
      doc.context.obj({ Illustrator: { LastModified: PDFString.of('D:20260101000000Z') } })
    );
    const formRef = doc.context.register(PDFRawStream.of(formDict, formContent));

    const page = doc.getPages()[0]!;
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm1: formRef } }));

    const pdfBytes = await doc.save({ useObjectStreams: false });

    const { cleanBytes, warnings } = await scrubPdfDeep(pdfBytes, {
      preserveIcc: true,
      allowSignedPdfScrub: false,
    });
    expect(warnings).toEqual([]);

    const report = await inspectPdf(cleanBytes);
    expect(report.totalTags).toBe(0);
    expect(report.riskLevel).toBe('clean');

    const cleanDoc = await PDFDocument.load(cleanBytes, { updateMetadata: false });
    const formStreams: PDFRawStream[] = [];
    for (const [, obj] of cleanDoc.context.enumerateIndirectObjects()) {
      if (
        obj instanceof PDFRawStream &&
        obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')
      ) {
        formStreams.push(obj);
      }
    }
    expect(formStreams).toHaveLength(1);
    expect(formStreams[0]!.dict.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(formStreams[0]!.dict.get(PDFName.of('PieceInfo'))).toBeUndefined();
    expect(formStreams[0]!.dict.get(PDFName.of('BBox'))).toBeDefined();
  });
});
