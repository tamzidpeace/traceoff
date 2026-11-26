import {
  decodePDFRawStream,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
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

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

export class PdfInspectError extends Error {
  readonly code: 'encrypted' | 'invalid';

  constructor(code: 'encrypted' | 'invalid', message: string) {
    super(message);
    this.name = 'PdfInspectError';
    this.code = code;
  }
}

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

function hasFilterName(dict: PDFDict, targetFilter: string): boolean {
  const filter = dict.get(PDFName.of('Filter'));
  if (filter instanceof PDFName) {
    return filter === PDFName.of(targetFilter);
  }
  if (filter instanceof PDFArray) {
    for (let i = 0; i < filter.size(); i++) {
      const item = filter.get(i);
      if (item instanceof PDFName && item === PDFName.of(targetFilter)) {
        return true;
      }
    }
  }
  return false;
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
  annotDict: PDFDict,
  pageNumber: number,
  annotIndex: number,
  fields: MetadataField[]
): void {
  const annotKeys: Array<{ pdfKey: string; label: string; category: MetadataField['category'] }> = [
    { pdfKey: 'T', label: 'Annotation Author', category: 'author' },
    { pdfKey: 'Subj', label: 'Annotation Subject', category: 'author' },
    { pdfKey: 'CreationDate', label: 'Annotation Created', category: 'dates' },
    { pdfKey: 'M', label: 'Annotation Modified', category: 'dates' },
  ];

  // Skip pure signature widget field names if it's a signature widget
  const ft = doc.context.lookup(annotDict.get(PDFName.of('FT')));
  if (ft === PDFName.of('Sig')) return;

  for (const spec of annotKeys) {
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

  const popup = doc.context.lookup(annotDict.get(PDFName.of('Popup')));
  if (popup instanceof PDFDict) {
    inspectAnnotationDict(doc, popup, pageNumber, annotIndex, fields);
  }
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

/**
 * Deeply inspect a PDF document for Info dictionary entries, XMP /Metadata,
 * /PieceInfo, /Annots authors/dates, cryptographic signatures, and embedded
 * JPEG image XObjects. Throws PdfInspectError('encrypted', ...) on encrypted PDFs.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<MetadataReport> {
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

  const fields: MetadataField[] = [];
  let hasGps = false;
  let embeddedImageWithMetaCount = 0;

  // 1. Document Info Dictionary
  inspectInfoDictionary(doc, fields);

  // 2. Catalog /Metadata (XMP) and /PieceInfo
  inspectDictXmpAndPieceInfo(doc, doc.catalog, 'catalog', 'Document', fields);

  // 3. Page-level /Metadata, /PieceInfo, and /Annots
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
        const annot = doc.context.lookup(annots.get(i));
        if (annot instanceof PDFDict) {
          inspectAnnotationDict(doc, annot, pageNum, i + 1, fields);
        }
      }
    }
  });

  // 4. Digital signatures
  const isSignedPdf = detectDigitalSignature(doc);

  // 5. Embedded Image XObjects (/Subtype /Image)
  let imageIndex = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const subtype = obj.dict.get(PDFName.of('Subtype'));
    if (subtype !== PDFName.of('Image')) continue;

    imageIndex++;
    let imageHasMeta = inspectDictXmpAndPieceInfo(
      doc,
      obj.dict,
      `embeddedImage:${imageIndex}`,
      `Embedded Image #${imageIndex}`,
      fields,
      'pdf-embedded'
    );

    if (obj instanceof PDFRawStream && hasFilterName(obj.dict, 'DCTDecode')) {
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
