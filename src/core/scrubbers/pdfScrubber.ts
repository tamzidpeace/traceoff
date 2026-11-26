import {
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
import {
  detectDigitalSignature,
  isSingleDctDecodeFilter,
  isXObjectStream,
  loadPdfDocument,
} from '../pdf/shared';
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

  const isWidget =
    doc.context.lookup(annotDict.get(PDFName.of('Subtype'))) === PDFName.of('Widget');

  for (const key of ANNOT_METADATA_KEYS) {
    if (isWidget && key === PDFName.of('T')) continue;
    annotDict.delete(key);
  }

  const popup = annotDict.get(PDFName.of('Popup'));
  if (popup !== undefined) {
    sanitizeAnnotation(doc, popup, visited);
  }
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
  const doc = await loadPdfDocument(bytes);

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

  // 4. Strip /Metadata & /PieceInfo on all XObjects (Image, Form, etc.) and losslessly scrub /DCTDecode JPEGs
  const xobjectStreams: Array<[PDFRef, PDFStream]> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && isXObjectStream(doc, obj)) {
      xobjectStreams.push([ref, obj]);
    }
  }

  let jpegStreamIndex = 0;
  for (const [ref, stream] of xobjectStreams) {
    stripDictMetadataAndPieceInfo(doc, stream.dict);

    const subtype = doc.context.lookup(stream.dict.get(PDFName.of('Subtype')));
    if (
      subtype === PDFName.of('Image') &&
      stream instanceof PDFRawStream &&
      isSingleDctDecodeFilter(doc, stream.dict)
    ) {
      jpegStreamIndex++;
      try {
        const scrubbedBytes = scrubJpegLossless(stream.getContents(), {
          preserveIcc: options.preserveIcc,
        });
        const newDict = PDFDict.withContext(doc.context);
        for (const [key, val] of stream.dict.entries()) {
          newDict.set(key, val);
        }
        newDict.set(PDFName.of('Length'), PDFNumber.of(scrubbedBytes.length));
        doc.context.assign(ref, PDFRawStream.of(newDict, scrubbedBytes));
      } catch {
        warnings.push(
          `Could not scrub embedded JPEG stream #${jpegStreamIndex} (non-standard or abbreviated JPEG encoding); stream preserved.`
        );
      }
    }
  }

  const cleanBytes = await doc.save({
    useObjectStreams: false,
    updateFieldAppearances: false,
  });

  return { cleanBytes, warnings };
}
