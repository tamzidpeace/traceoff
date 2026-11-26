import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import {
  detectDigitalSignature,
  isSingleDctDecodeFilter,
  isXObjectStream,
  loadPdfDocument,
  PdfInspectError,
} from '../pdf/shared';
import type { MetadataField, MetadataReport } from '../types';
import { inspectImage } from './inspectImage';
import {
  classifyMetadataKey,
  computeRiskLevel,
  deduplicateFields,
  extractXmpFields,
  formatTagLabel,
  hasGpsField,
} from './shared';

export { PdfInspectError };

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function decodePdfTextValue(obj: unknown): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    return obj.decodeText().trim();
  }
  if (obj instanceof PDFName) {
    return obj.decodeText().trim();
  }
  return '';
}

function decodeMetadataStream(stream: PDFStream): string {
  try {
    if (stream instanceof PDFRawStream) {
      const filter = stream.dict.get(PDFName.of('Filter'));
      if (filter) {
        return utf8Decoder.decode(decodePDFRawStream(stream).decode());
      }
      return utf8Decoder.decode(stream.getContents());
    }
    return utf8Decoder.decode(stream.getContents());
  } catch {
    return '';
  }
}

function inspectInfoDictionary(doc: PDFDocument, fields: MetadataField[]): void {
  const standardFields: Array<{
    key: string;
    label: string;
    value: string | undefined;
  }> = [
    { key: 'Title', label: 'Document Title', value: doc.getTitle() },
    { key: 'Author', label: 'Author', value: doc.getAuthor() },
    { key: 'Subject', label: 'Subject', value: doc.getSubject() },
    { key: 'Keywords', label: 'Keywords', value: doc.getKeywords() },
    { key: 'Creator', label: 'Creator Application', value: doc.getCreator() },
    { key: 'Producer', label: 'PDF Producer', value: doc.getProducer() },
    {
      key: 'CreationDate',
      label: 'Creation Date',
      value: doc.getCreationDate()?.toISOString(),
    },
    {
      key: 'ModDate',
      label: 'Modification Date',
      value: doc.getModificationDate()?.toISOString(),
    },
  ];

  const handledKeys = new Set<string>();
  for (const item of standardFields) {
    handledKeys.add(item.key);
    const val = item.value?.trim();
    if (!val) continue;
    const { category, sensitive } = classifyMetadataKey(item.key);
    fields.push({
      key: `info:${item.key}`,
      label: item.label,
      value: val,
      category,
      sensitive,
    });
  }

  // Also check raw trailer /Info dict for non-standard custom keys
  const infoRef = doc.context.trailerInfo.Info;
  const infoDict = doc.context.lookup(infoRef);
  if (infoDict instanceof PDFDict) {
    for (const [nameObj, rawVal] of infoDict.entries()) {
      const key = nameObj.decodeText();
      if (handledKeys.has(key)) continue;
      const resolved = doc.context.lookup(rawVal);
      const val = decodePdfTextValue(resolved);
      if (!val) continue;
      const { category, sensitive } = classifyMetadataKey(key);
      fields.push({
        key: `info:${key}`,
        label: formatTagLabel(key),
        value: val,
        category,
        sensitive,
      });
    }
  }
}

function inspectDictXmpAndPieceInfo(
  doc: PDFDocument,
  dict: PDFDict,
  prefix: string,
  labelPrefix: string,
  fields: MetadataField[],
  categoryOverride?: MetadataField['category']
): boolean {
  let found = false;

  const metaObj = doc.context.lookup(dict.get(PDFName.of('Metadata')));
  if (metaObj instanceof PDFStream) {
    const xml = decodeMetadataStream(metaObj);
    const xmpFields = extractXmpFields(xml, `${prefix}:xmp`);
    for (const f of xmpFields) {
      fields.push(
        categoryOverride
          ? { ...f, category: categoryOverride, label: `${labelPrefix} ${f.label}` }
          : f
      );
    }
    if (xmpFields.length > 0) found = true;
  }

  const pieceObj = doc.context.lookup(dict.get(PDFName.of('PieceInfo')));
  if (pieceObj instanceof PDFDict) {
    const appNames = pieceObj
      .keys()
      .map((k) => k.decodeText())
      .join(', ');
    fields.push({
      key: `${prefix}:pieceInfo`,
      label: `${labelPrefix} PieceInfo`,
      value: appNames || 'Application metadata dictionary',
      category: categoryOverride ?? 'author',
      sensitive: true,
    });
    found = true;
  }

  return found;
}

function inspectAnnotationDict(
  doc: PDFDocument,
  annotItem: PDFObject | undefined,
  pageNumber: number,
  annotIndex: number,
  fields: MetadataField[],
  visited: Set<PDFRef>
): void {
  if (annotItem instanceof PDFRef) {
    if (visited.has(annotItem)) return;
    visited.add(annotItem);
  }

  const annotDict = doc.context.lookup(annotItem);
  if (!(annotDict instanceof PDFDict)) return;

  const annotKeys: Array<{ pdfKey: string; label: string; category: MetadataField['category'] }> = [
    { pdfKey: 'T', label: 'Annotation Author', category: 'author' },
    { pdfKey: 'Subj', label: 'Annotation Subject', category: 'author' },
    { pdfKey: 'CreationDate', label: 'Annotation Created', category: 'dates' },
    { pdfKey: 'M', label: 'Annotation Modified', category: 'dates' },
  ];

  // Skip pure signature widget field names if it's a signature widget
  const ft = doc.context.lookup(annotDict.get(PDFName.of('FT')));
  if (ft === PDFName.of('Sig')) return;

  const isWidget =
    doc.context.lookup(annotDict.get(PDFName.of('Subtype'))) === PDFName.of('Widget');

  for (const spec of annotKeys) {
    if (isWidget && spec.pdfKey === 'T') continue;
    const raw = doc.context.lookup(annotDict.get(PDFName.of(spec.pdfKey)));
    const val = decodePdfTextValue(raw);
    if (!val) continue;
    fields.push({
      key: `annot:p${pageNumber}:${annotIndex}:${spec.pdfKey}`,
      label: `${spec.label} (Page ${pageNumber})`,
      value: val,
      category: spec.category,
      sensitive: true,
    });
  }

  const popup = annotDict.get(PDFName.of('Popup'));
  if (popup !== undefined) {
    inspectAnnotationDict(doc, popup, pageNumber, annotIndex, fields, visited);
  }
}

/**
 * Deeply inspect a PDF document for Info dictionary entries, XMP /Metadata,
 * /PieceInfo, /Annots authors/dates, cryptographic signatures, and embedded
 * XObjects (Image/Form). Throws PdfInspectError('encrypted', ...) on encrypted PDFs.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<MetadataReport> {
  const doc = await loadPdfDocument(bytes);

  const fields: MetadataField[] = [];
  let hasGps = false;
  let embeddedImageWithMetaCount = 0;

  // 1. Document Info Dictionary
  inspectInfoDictionary(doc, fields);

  // 2. Catalog /Metadata (XMP) and /PieceInfo
  inspectDictXmpAndPieceInfo(doc, doc.catalog, 'catalog', 'Document', fields);

  // 3. Page-level /Metadata, /PieceInfo, and /Annots
  const visitedAnnotRefs = new Set<PDFRef>();
  const pages = doc.getPages();
  pages.forEach((page, pageIdx) => {
    const pageNum = pageIdx + 1;
    inspectDictXmpAndPieceInfo(
      doc,
      page.node,
      `page${pageNum}`,
      `Page ${pageNum}`,
      fields
    );

    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        inspectAnnotationDict(doc, annots.get(i), pageNum, i + 1, fields, visitedAnnotRefs);
      }
    }
  });

  // 4. Digital signatures
  const isSignedPdf = detectDigitalSignature(doc);

  // 5. Embedded XObjects (/Subtype /Image, /Subtype /Form, or /Type /XObject)
  let imageIndex = 0;
  let xobjectIndex = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream) || !isXObjectStream(doc, obj)) continue;

    const subtype = doc.context.lookup(obj.dict.get(PDFName.of('Subtype')));
    if (subtype !== PDFName.of('Image')) {
      xobjectIndex++;
      inspectDictXmpAndPieceInfo(
        doc,
        obj.dict,
        `xobject:${xobjectIndex}`,
        `Form XObject #${xobjectIndex}`,
        fields
      );
      continue;
    }

    imageIndex++;
    let imageHasMeta = inspectDictXmpAndPieceInfo(
      doc,
      obj.dict,
      `embeddedImage:${imageIndex}`,
      `Embedded Image #${imageIndex}`,
      fields,
      'pdf-embedded'
    );

    if (obj instanceof PDFRawStream && isSingleDctDecodeFilter(doc, obj.dict)) {
      const jpegBytes = obj.getContents();
      const imgReport = await inspectImage(jpegBytes, 'jpeg');
      if (imgReport.hasGps) {
        hasGps = true;
      }
      if (imgReport.totalTags > 0) {
        imageHasMeta = true;
        for (const f of imgReport.fields) {
          fields.push({
            key: `embeddedImage:${imageIndex}:${f.key}`,
            label: `Embedded Image #${imageIndex} ${f.label}`,
            value: f.value,
            category: 'pdf-embedded',
            sensitive: f.sensitive,
          });
        }
      }
    }

    if (imageHasMeta) {
      embeddedImageWithMetaCount++;
    }
  }

  const deduped = deduplicateFields(fields);
  hasGps = hasGps || hasGpsField(deduped);
  const totalTags = deduped.length;

  return {
    format: 'pdf',
    riskLevel: computeRiskLevel(hasGps, totalTags),
    hasGps,
    orientation: null,
    hasIccProfile: false,
    isSignedPdf,
    embeddedImageWithMetaCount,
    fields: deduped,
    totalTags,
  };
}
