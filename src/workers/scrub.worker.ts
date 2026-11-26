import {
  inspectFile,
  needsOrientationBaking,
  scrubFileWithReport,
} from '../core/scrubFile';
import type {
  SerializedWorkerError,
  WorkerRequest,
  WorkerResponse,
} from '../core/workerClient';

interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScopeLike;

function supportsOffscreenOrientationBaking(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function'
  );
}

function serializeError(err: unknown): SerializedWorkerError {
  if (err instanceof Error) {
    const maybeCode = (err as Error & { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      code: typeof maybeCode === 'string' ? maybeCode : undefined,
    };
  }
  return {
    name: 'Error',
    message: typeof err === 'string' ? err : 'Unknown worker error',
  };
}

function getTransferableBuffer(bytes: Uint8Array): Transferable[] {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return [bytes.buffer];
  }
  return [];
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  try {
    if (req.type === 'inspect') {
      const report = await inspectFile(req.bytes);
      workerScope.postMessage({ id: req.id, type: 'inspect-result', report });
      return;
    }

    const before = await inspectFile(req.bytes);
    if (needsOrientationBaking(before, req.options) && !supportsOffscreenOrientationBaking()) {
      workerScope.postMessage({
        id: req.id,
        type: 'needs-main-thread-orientation',
        before,
      });
      return;
    }

    const result = await scrubFileWithReport(req.bytes, before, req.options);
    workerScope.postMessage(
      { id: req.id, type: 'scrub-result', result },
      getTransferableBuffer(result.cleanBytes)
    );
  } catch (err) {
    workerScope.postMessage({
      id: req.id,
      type: 'error',
      error: serializeError(err),
    });
  }
};
