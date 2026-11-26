import { describe, it, expect } from 'vitest';
import { detectFormat } from '../src/core/detectFormat';

describe('detectFormat', () => {
  it('detects JPEG magic bytes', () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).toBe('jpeg');
  });

  it('detects PNG magic bytes', () => {
    expect(
      detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toBe('png');
  });

  it('detects WebP RIFF/WEBP magic bytes', () => {
    const webp = new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBP');
    expect(detectFormat(webp)).toBe('webp');
  });

  it('detects PDF magic bytes (including leading whitespace/BOM)', () => {
    expect(detectFormat(new TextEncoder().encode('%PDF-1.7\n'))).toBe('pdf');
    expect(detectFormat(new TextEncoder().encode('\uFEFF  \r\n%PDF-1.4\n'))).toBe('pdf');
  });

  it('returns null for disguised HEIC/ftyp, non-WebP RIFF, or truncated inputs', () => {
    expect(
      detectFormat(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))
    ).toBeNull();
    expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(detectFormat(new Uint8Array([]))).toBeNull();
    expect(detectFormat(new TextEncoder().encode('RIFF\x00\x00\x00\x00WAVE'))).toBeNull();
    const latePdf = new Uint8Array(1035);
    latePdf.set(new TextEncoder().encode('%PDF-1.7'), 1025);
    expect(detectFormat(latePdf)).toBeNull();
  });
});
