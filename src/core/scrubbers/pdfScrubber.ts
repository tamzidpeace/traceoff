import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { PdfInspectError } from '../inspector/inspectPdf';
import { scrubJpegLossless } from './jpegScrubber';

export interface PdfScrubOptions {
  preserveIcc: boolean;
  allowSignedPdfScrub: boolean;
}

export interface PdfScrubResult {
  cleanBytes: Uint8Array;
  warnings: string[];
}

export class PdfScrubError extends Error {
  readonly code: 'signed-confirmation-required';

  constructor(code: 'signed-confirmation-required', message: string) {
    super(message);
    this.name = 'PdfScrubError';
    this.code = code;
  }
}

const ANNOT_METADATA_KEYS = [
  PDFName.of('T'),
  PDFName.of('Subj'),
  PDFName.of('CreationDate'),
  PDFName.of('M'),
] as const;

const DICT_METADATA_KEYS = [
  PDFName.of('Metadata'),
  PDFName.of('PieceInfo'),
] as const;

function hasSignatureField(
  doc: PDFDocument,
  fieldsArray: PDFArray,
  visited: Set<PDFRef>
): boolean {
  for (let i = 0; i < fieldsArray.size(); i++) {
    const item = fieldsArray.get(i);
    if (item instanceof PDFRef) {
      if (visited.has(item)) continue;
      visited.add(item);
    }

    const dict = doc.context.lookup(item);
    if (!(dict instanceof PDFDict)) continue;

    if (
      dict.get(PDFName.of('FT')) === PDFName.of('Sig') ||
      dict.get(PDFName.of('ByteRange')) !== undefined
    ) {
      return true;
    }

    const v = doc.context.lookup(dict.get(PDFName.of('V')));
    if (
      v instanceof PDFDict &&
      (v.get(PDFName.of('Type')) === PDFName.of('Sig') ||
        v.get(PDFName.of('ByteRange')) !== undefined)
    ) {
      return true;
    }

    const kids = doc.context.lookup(dict.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray && hasSignatureField(doc, kids, visited)) {
      return true;
    }
  }
  return false;
}

function detectDigitalSignature(doc: PDFDocument): boolean {
  const acroForm = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  if (acroForm instanceof PDFDict) {
    const fields = doc.context.lookup(acroForm.get(PDFName.of('Fields')));
    if (fields instanceof PDFArray && hasSignatureField(doc, fields, new Set())) {
      return true;
    }
  }

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) {
      const type = obj.get(PDFName.of('Type'));
      const ft = obj.get(PDFName.of('FT'));
      const byteRange = obj.get(PDFName.of('ByteRange'));
      if (type === PDFName.of('Sig') || ft === PDFName.of('Sig') || byteRange !== undefined) {
        return true;
      }
    }
  }

  return false;
}

function stripDictMetadataAndPieceInfo(doc: PDFDocument, dict: PDFDict): void {
  for (const key of DICT_METADATA_KEYS) {
    const val = dict.get(key);
    if (val instanceof PDFRef) {
      doc.context.delete(val);
    }
    dict.delete(key);
  }
}

function sanitizeAnnotation(
  doc: PDFDocument,
  annotItem: PDFObject | undefined,
  visited: Set<PDFRef>
): void {
  if (annotItem instanceof PDFRef) {
    if (visited.has(annotItem)) return;
    visited.add(annotItem);
  }

  const annotDict = doc.context.lookup(annotItem);
  if (!(annotDict instanceof PDFDict)) return;

  // Preserve cryptographic signature widget fields
  if (doc.context.lookup(annotDict.get(PDFName.of('FT'))) === PDFName.of('Sig')) {
    return;
  }

  for (const key of ANNOT_METADATA_KEYS) {
    annotDict.delete(key);
  }

  const popup = annotDict.get(PDFName.of('Popup'));
  if (popup !== undefined) {
    sanitizeAnnotation(doc, popup, visited);
  }
}

function isSingleDctDecodeFilter(doc: PDFDocument, dict: PDFDict): boolean {
  const filter = doc.context.lookup(dict.get(PDFName.of('Filter')));
  if (filter === PDFName.of('DCTDecode')) {
    return true;
  }
  if (filter instanceof PDFArray && filter.size() === 1) {
    return doc.context.lookup(filter.get(0)) === PDFName.of('DCTDecode');
  }
  return false;
}

/**
 * Deeply scrub metadata from a PDF document: trailer /Info dictionary,
 * catalog/page/XObject /Metadata (XMP) and /PieceInfo, annotation authors/dates,
 * and embedded /DCTDecode JPEG XObjects via lossless JPEG scrubbing.
 */
export async function scrubPdfDeep(
  bytes: Uint8Array,
  options: PdfScrubOptions
): Promise<PdfScrubResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (
      err instanceof EncryptedPDFError ||
      (err instanceof Error && /encrypt/i.test(err.message))
    ) {
      throw new PdfInspectError(
        'encrypted',
        'This PDF is encrypted or password-protected and cannot be inspected or scrubbed in the browser.'
      );
    }
    throw new PdfInspectError(
      'invalid',
      err instanceof Error ? `Invalid or corrupt PDF: ${err.message}` : 'Invalid or corrupt PDF'
    );
  }

  const warnings: string[] = [];
  if (detectDigitalSignature(doc)) {
    if (!options.allowSignedPdfScrub) {
      throw new PdfScrubError(
        'signed-confirmation-required',
        'This PDF contains a digital signature. Scrubbing metadata will invalidate its cryptographic signatures.'
      );
    }
    warnings.push(
      'Cryptographic digital signatures in this PDF have been invalidated by modifying the document.'
    );
  }

  // 1. Remove trailer /Info completely so neither custom keys nor default Producer remain
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef instanceof PDFRef) {
    doc.context.delete(infoRef);
  }
  delete doc.context.trailerInfo.Info;

  // 2. Strip catalog /Metadata and /PieceInfo
  stripDictMetadataAndPieceInfo(doc, doc.catalog);

  // 3. Strip page /Metadata, /PieceInfo, and sanitize /Annots (and /Popup)
  const visitedAnnotRefs = new Set<PDFRef>();
  for (const page of doc.getPages()) {
    stripDictMetadataAndPieceInfo(doc, page.node);

    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        sanitizeAnnotation(doc, annots.get(i), visitedAnnotRefs);
      }
    }
  }

  // 4. Strip /Metadata & /PieceInfo on image XObjects and losslessly scrub /DCTDecode JPEGs
  const imageStreams: Array<[PDFRef, PDFStream]> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      imageStreams.push([ref, obj]);
    }
  }

  for (const [ref, stream] of imageStreams) {
    stripDictMetadataAndPieceInfo(doc, stream.dict);

    if (stream instanceof PDFRawStream && isSingleDctDecodeFilter(doc, stream.dict)) {
      const scrubbedBytes = scrubJpegLossless(stream.getContents(), {
        preserveIcc: options.preserveIcc,
      });
      const newDict = PDFDict.withContext(doc.context);
      for (const [key, val] of stream.dict.entries()) {
        newDict.set(key, val);
      }
      newDict.set(PDFName.of('Length'), PDFNumber.of(scrubbedBytes.length));
      doc.context.assign(ref, PDFRawStream.of(newDict, scrubbedBytes));
    }
  }

  const cleanBytes = await doc.save({
    useObjectStreams: false,
    updateFieldAppearances: false,
  });

  return { cleanBytes, warnings };
}
