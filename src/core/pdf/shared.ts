import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
} from 'pdf-lib';

export class PdfInspectError extends Error {
  readonly code: 'encrypted' | 'invalid';

  constructor(code: 'encrypted' | 'invalid', message: string) {
    super(message);
    this.name = 'PdfInspectError';
    this.code = code;
  }
}

export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
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
}

export function hasSignatureField(
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

export function detectDigitalSignature(doc: PDFDocument): boolean {
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

export function isXObjectStream(doc: PDFDocument, stream: PDFStream): boolean {
  const subtype = doc.context.lookup(stream.dict.get(PDFName.of('Subtype')));
  const type = doc.context.lookup(stream.dict.get(PDFName.of('Type')));
  return (
    subtype === PDFName.of('Image') ||
    subtype === PDFName.of('Form') ||
    type === PDFName.of('XObject')
  );
}

export function isSingleDctDecodeFilter(doc: PDFDocument, dict: PDFDict): boolean {
  const filter = doc.context.lookup(dict.get(PDFName.of('Filter')));
  if (filter === PDFName.of('DCTDecode')) {
    return true;
  }
  if (filter instanceof PDFArray && filter.size() === 1) {
    return doc.context.lookup(filter.get(0)) === PDFName.of('DCTDecode');
  }
  return false;
}
