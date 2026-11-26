import type { MetadataCategory, MetadataField, RiskLevel } from '../types';

const LOCATION_KEY_RE =
  /(gps|latitude|longitude|altitude|location|city|country|sublocation|state|province)/i;
const DEVICE_KEY_RE =
  /^(make|model|lens|lensmodel|lensmake|lensinfo|serialnumber|bodyserialnumber|internalserialnumber|cameraownername|cameraprofile|hostcomputer|exposuretime|fnumber|iso|isospeedratings|focallength|flash|whitebalance|meteringmode|shutterspeedvalue|aperturevalue|device)$/i;
const AUTHOR_KEY_RE =
  /(author|artist|creator|creatortool|software|producer|copyright|owner|by-?line|credit|title|subject|keywords|contributor|publisher|rights|history|toolkit)/i;
const DATE_KEY_RE =
  /(date|time|created|modified|modifydate|createdate|datetimeoriginal|metadatadate|tIME)/i;

export function classifyMetadataKey(key: string): {
  category: MetadataCategory;
  sensitive: boolean;
} {
  if (LOCATION_KEY_RE.test(key)) {
    return { category: 'location', sensitive: true };
  }
  if (DEVICE_KEY_RE.test(key)) {
    return { category: 'device', sensitive: true };
  }
  if (AUTHOR_KEY_RE.test(key)) {
    return { category: 'author', sensitive: true };
  }
  if (DATE_KEY_RE.test(key)) {
    return { category: 'dates', sensitive: true };
  }
  const lower = key.toLowerCase();
  const nonSensitiveTechnical =
    lower === 'orientation' ||
    lower === 'xresolution' ||
    lower === 'yresolution' ||
    lower === 'resolutionunit' ||
    lower === 'colorspace' ||
    lower === 'exifversion' ||
    lower === 'flashpixversion' ||
    lower === 'componentsconfiguration' ||
    lower === 'ycbcrpositioning';

  return {
    category: 'other',
    sensitive: !nonSensitiveTechnical,
  };
}

export function formatTagLabel(key: string): string {
  return key
    .replace(/^[a-z0-9_-]+:/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `<binary ${value.length} bytes>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatMetadataValue(item)).join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).replace(/\0+$/, '').trim();
}

export function computeRiskLevel(hasGps: boolean, totalTags: number): RiskLevel {
  if (hasGps) return 'high';
  if (totalTags > 0) return 'medium';
  return 'clean';
}

const GPS_FIELD_KEY_RE = /(gps|latitude|longitude)/i;

export function hasGpsField(fields: readonly MetadataField[]): boolean {
  return fields.some((field) => GPS_FIELD_KEY_RE.test(field.key));
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

const XMP_CONTAINER_TAGS = new Set([
  'x:xmpmeta',
  'rdf:RDF',
  'rdf:Description',
  'rdf:Seq',
  'rdf:Bag',
  'rdf:Alt',
  'rdf:li',
]);

/**
 * Lightweight XML/RDF-aware XMP extractor for XMP streams when `exifr` returns
 * raw XML or when inspecting PDF/WebP/PNG/JPEG XMP payloads directly.
 * Supports namespaced attributes, flat elements, and nested RDF containers
 * (`<rdf:Seq>`, `<rdf:Bag>`, `<rdf:Alt>` with `<rdf:li>`).
 */
export function extractXmpFields(xml: string, keyPrefix = 'xmp'): MetadataField[] {
  const fields: MetadataField[] = [];
  const seen = new Set<string>();

  const pushField = (rawKey: string, rawVal: string) => {
    const val = decodeXmlEntities(rawVal).replace(/\s+/g, ' ').trim();
    if (!val) return;
    const key = `${keyPrefix}:${rawKey}`;
    const dedup = `${key}=${val}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    const { category, sensitive } = classifyMetadataKey(rawKey);
    fields.push({
      key,
      label: `XMP ${formatTagLabel(rawKey)}`,
      value: val,
      category,
      sensitive,
    });
  };

  const stack: Array<{ tag: string; isContainer: boolean; values: string[] }> = [];
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w-]*(?::[a-zA-Z][\w-]*)?)([^>]*?)(\/?)>/g;
  const attrRe = /\b([a-zA-Z][\w-]*:[a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;

  let lastIndex = 0;
  for (const match of xml.matchAll(tokenRe)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      const text = xml.slice(lastIndex, matchIndex).trim();
      if (text) {
        // Attach text to nearest non-container property element on stack
        for (let i = stack.length - 1; i >= 0; i--) {
          const item = stack[i];
          if (item && !item.isContainer) {
            item.values.push(text);
            break;
          }
        }
      }
    }
    lastIndex = matchIndex + match[0].length;

    const isClosing = match[1] === '/';
    const tagName = match[2];
    const attrsPart = match[3] ?? '';
    const isSelfClosing = match[4] === '/';

    if (!tagName) continue; // comment or processing instruction

    if (!isClosing) {
      // Extract namespaced attributes (skip xmlns:*, rdf:*, xml:*)
      for (const attrMatch of attrsPart.matchAll(attrRe)) {
        const attrName = attrMatch[1];
        const attrVal = attrMatch[2];
        if (!attrName || attrVal === undefined) continue;
        if (
          attrName.startsWith('xmlns:') ||
          attrName.startsWith('rdf:') ||
          attrName.startsWith('xml:')
        ) {
          continue;
        }
        pushField(attrName, attrVal);
      }

      if (!isSelfClosing) {
        const isContainer =
          XMP_CONTAINER_TAGS.has(tagName) ||
          tagName.startsWith('rdf:') ||
          tagName.startsWith('x:') ||
          !tagName.includes(':');
        stack.push({ tag: tagName, isContainer, values: [] });
      }
    } else {
      // Pop matching tag from stack
      for (let i = stack.length - 1; i >= 0; i--) {
        const item = stack[i];
        if (item && item.tag === tagName) {
          stack.splice(i, 1);
          if (!item.isContainer && item.values.length > 0) {
            pushField(item.tag, item.values.join(', '));
          }
          break;
        }
      }
    }
  }

  // Fallback: if XMP XML exists but no individual tags matched, still report XMP presence
  if (fields.length === 0 && xml.trim().length > 0) {
    fields.push({
      key: `${keyPrefix}:raw`,
      label: 'XMP Metadata Stream',
      value: `${xml.length} bytes`,
      category: 'other',
      sensitive: true,
    });
  }

  return fields;
}

export function deduplicateFields(fields: MetadataField[]): MetadataField[] {
  const seen = new Set<string>();
  const result: MetadataField[] = [];
  for (const field of fields) {
    const sig = `${field.key.toLowerCase()}::${field.value}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(field);
  }
  return result;
}
