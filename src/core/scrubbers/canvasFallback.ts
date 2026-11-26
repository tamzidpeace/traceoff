async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('Failed to read encoded Blob as ArrayBuffer'));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader failed while reading encoded Blob'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Re-encode an image via HTML5 Canvas with EXIF orientation baked into pixel order
 * (`imageOrientation: 'from-image'`), producing clean sRGB JPEG bytes with zero metadata or ICC.
 * Prefers `OffscreenCanvas` (works in Web Workers) and falls back to DOM `HTMLCanvasElement`.
 */
export async function bakeOrientedImageCanvas(
  bytes: Uint8Array,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
): Promise<Uint8Array> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is not supported in this browser environment');
  }

  const inputCopy = new Uint8Array(bytes);
  const inputBlob = new Blob([inputCopy], { type: mimeType });
  const bitmap = await createImageBitmap(inputBlob, { imageOrientation: 'from-image' });

  try {
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0) {
      throw new Error(`Decoded image has invalid dimensions (${width}x${height})`);
    }

    if (typeof OffscreenCanvas !== 'undefined') {
      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to acquire 2D context from OffscreenCanvas');
      }
      ctx.drawImage(bitmap, 0, 0);
      if (typeof offscreen.convertToBlob === 'function') {
        const outBlob = await offscreen.convertToBlob({
          type: 'image/jpeg',
          quality: 0.95,
        });
        return await blobToUint8Array(outBlob);
      }
    }

    if (typeof document === 'undefined') {
      throw new Error('Neither OffscreenCanvas nor DOM canvas is available in this environment');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context from HTMLCanvasElement');
    }
    ctx.drawImage(bitmap, 0, 0);

    const outBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Canvas toBlob returned null while encoding JPEG output'));
          }
        },
        'image/jpeg',
        0.95
      );
    });

    return await blobToUint8Array(outBlob);
  } finally {
    bitmap.close();
  }
}
