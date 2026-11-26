export type SupportedFormat = 'jpeg' | 'png' | 'webp' | 'pdf';

export type RiskLevel = 'high' | 'medium' | 'clean';

export type ScrubMode = 'lossless' | 'oriented-srgb' | 'pdf-deep' | 'already-clean';

export type MetadataCategory =
  | 'location'
  | 'device'
  | 'author'
  | 'dates'
  | 'pdf-embedded'
  | 'other';

export interface MetadataField {
  key: string;
  label: string;
  value: string;
  category: MetadataCategory;
  sensitive: boolean;
}

export interface MetadataReport {
  format: SupportedFormat;
  riskLevel: RiskLevel;
  hasGps: boolean;
  orientation: number | null;
  hasIccProfile: boolean;
  isSignedPdf: boolean;
  embeddedImageWithMetaCount: number;
  fields: MetadataField[];
  totalTags: number;
}

export interface ScrubOptions {
  preserveIcc: boolean;
  autoFixOrientation: boolean;
  allowSignedPdfScrub: boolean;
  filenameMode: 'suffix' | 'original';
}

export interface ScrubResult {
  format: SupportedFormat;
  cleanBytes: Uint8Array;
  mode: ScrubMode;
  before: MetadataReport;
  after: MetadataReport;
  originalSize: number;
  cleanSize: number;
  warnings: string[];
}
