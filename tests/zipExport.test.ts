import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildZipArchive } from '../src/core/zipExport';

const encoder = new TextEncoder();

describe('buildZipArchive', () => {
  it('compresses multiple files and preserves exact contents when unzipped', () => {
    const aBytes = encoder.encode('alpha-file-contents');
    const bBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

    const zipBytes = buildZipArchive([
      { name: 'notes.txt', bytes: aBytes },
      { name: 'image-clean.jpg', bytes: bBytes },
    ]);

    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual(['image-clean.jpg', 'notes.txt']);
    expect(Array.from(unzipped['notes.txt']!)).toEqual(Array.from(aBytes));
    expect(Array.from(unzipped['image-clean.jpg']!)).toEqual(Array.from(bBytes));
  });

  it('deduplicates colliding filenames cleanly with (1), (2), ... suffixes', () => {
    const b1 = encoder.encode('first');
    const b2 = encoder.encode('second');
    const b3 = encoder.encode('third');

    const zipBytes = buildZipArchive([
      { name: 'photo.jpg', bytes: b1 },
      { name: 'photo.jpg', bytes: b2 },
      { name: 'photo.jpg', bytes: b3 },
    ]);

    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual([
      'photo (1).jpg',
      'photo (2).jpg',
      'photo.jpg',
    ]);
    expect(Array.from(unzipped['photo.jpg']!)).toEqual(Array.from(b1));
    expect(Array.from(unzipped['photo (1).jpg']!)).toEqual(Array.from(b2));
    expect(Array.from(unzipped['photo (2).jpg']!)).toEqual(Array.from(b3));
  });

  it('avoids colliding with pre-existing numbered names and handles extensionless/dotfile names', () => {
    const zipBytes = buildZipArchive([
      { name: 'photo.jpg', bytes: encoder.encode('1') },
      { name: 'photo (1).jpg', bytes: encoder.encode('2') },
      { name: 'photo.jpg', bytes: encoder.encode('3') },
      { name: 'README', bytes: encoder.encode('r1') },
      { name: 'README', bytes: encoder.encode('r2') },
      { name: '.env', bytes: encoder.encode('e1') },
      { name: '.env', bytes: encoder.encode('e2') },
    ]);

    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual([
      '.env',
      '.env (1)',
      'README',
      'README (1)',
      'photo (1).jpg',
      'photo (2).jpg',
      'photo.jpg',
    ]);
    expect(Array.from(unzipped['photo.jpg']!)).toEqual(Array.from(encoder.encode('1')));
    expect(Array.from(unzipped['photo (1).jpg']!)).toEqual(Array.from(encoder.encode('2')));
    expect(Array.from(unzipped['photo (2).jpg']!)).toEqual(Array.from(encoder.encode('3')));
    expect(Array.from(unzipped['README (1)']!)).toEqual(Array.from(encoder.encode('r2')));
    expect(Array.from(unzipped['.env (1)']!)).toEqual(Array.from(encoder.encode('e2')));
  });

  it('produces a valid empty ZIP archive when given an empty entry list', () => {
    const zipBytes = buildZipArchive([]);
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped)).toEqual([]);
  });
});
