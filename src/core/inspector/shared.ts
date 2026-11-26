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

/**
 * Lightweight regex-based XMP attribute & simple element extractor for XML streams
 * when `exifr` returns raw XML or when inspecting PDF/WebP/PNG XMP payloads directly.
 */
export function extractXmpFields(xml: string, keyPrefix = 'xmp'): MetadataField[] {
  const fields: MetadataField[] = [];
  const seen = new Set<string>();

  const pushField = (rawKey: string, rawVal: string) => {
    const val = rawVal.replace(/\s+/g, ' ').trim();
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

  // Match namespaced attributes on rdf:Description or other XMP nodes (skip xmlns:*)
  const attrRe = /\b([a-zA-Z][\w-]*:[a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  for (const match of xml.matchAll(attrRe)) {
    const attrName = match[1];
    const attrVal = match[2];
    if (!attrName || attrVal === undefined) continue;
    if (attrName.startsWith('xmlns:') || attrName === 'rdf:about') continue;
    pushField(attrName, attrVal);
  }

  // Match simple leaf elements like <dc:creator>...<rdf:li>Name</rdf:li>...</dc:creator>
  // or <xmp:CreatorTool>Lightroom</xmp:CreatorTool>
  const elemRe = /<([a-zA-Z][\w-]*:[a-zA-Z][\w-]*)\b[^>]*>([^<]+)<\/\1>/g;
  for (const match of xml.matchAll(elemRe)) {
    const tagName = match[1];
    const textVal = match[2];
    if (!tagName || textVal === undefined) continue;
    if (tagName.startsWith('rdf:') || tagName.startsWith('x:')) continue;
    pushField(tagName, textVal);
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
