import { PdfInspectError } from './inspector/inspectPdf';
import {
  completeOrientedJpegScrub,
  inspectFile,
  scrubFile,
  UnsupportedFormatError,
} from './scrubFile';
import { PdfScrubError } from './scrubbers/pdfScrubber';
import type { MetadataReport, ScrubOptions, ScrubResult } from './types';

export interface SerializedWorkerError {
  name: string;
  message: string;
  code?: string;
}

export type WorkerRequest =
  | { id: number; type: 'inspect'; bytes: Uint8Array }
  | { id: number; type: 'scrub'; bytes: Uint8Array; options: ScrubOptions };

export type WorkerResponse =
  | { id: number; type: 'inspect-result'; report: MetadataReport }
  | { id: number; type: 'scrub-result'; result: ScrubResult }
  | { id: number; type: 'needs-main-thread-orientation'; before: MetadataReport }
  | { id: number; type: 'error'; error: SerializedWorkerError };

type PendingRequest =
  | {
      kind: 'inspect';
      resolve: (report: MetadataReport) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: 'scrub';
      bytes: Uint8Array;
      options: ScrubOptions;
      resolve: (result: ScrubResult) => void;
      reject: (error: Error) => void;
    };

function rehydrateWorkerError(err: SerializedWorkerError): Error {
  if (
    err.name === 'PdfInspectError' &&
    (err.code === 'encrypted' || err.code === 'invalid')
  ) {
    return new PdfInspectError(err.code, err.message);
  }
  if (
    err.name === 'PdfScrubError' &&
    err.code === 'signed-confirmation-required'
  ) {
    return new PdfScrubError(err.code, err.message);
  }
  if (
    err.name === 'UnsupportedFormatError' ||
    err.code === 'unsupported-format'
  ) {
    return new UnsupportedFormatError(err.message);
  }

  const generic = new Error(err.message);
  generic.name = err.name || 'Error';
  return generic;
}

/**
 * Main-thread bridge for the inspection & scrubbing Web Worker, with automatic
 * Safari main-thread orientation fallback, error rehydration, and direct execution
 * fallback when Web Workers are unavailable.
 */
export class ScrubWorkerClient {
  private readonly workerFactory?: () => Worker;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private disposed = false;
  private fallbackToDirect = false;

  constructor(workerFactory?: () => Worker) {
    this.workerFactory = workerFactory;
  }

  private getOrCreateWorker(): Worker | null {
    if (this.disposed) {
      throw new Error('ScrubWorkerClient has been disposed');
    }
    if (this.fallbackToDirect || typeof Worker === 'undefined') {
      return null;
    }
    if (this.worker) {
      return this.worker;
    }

    try {
      const worker = this.workerFactory
        ? this.workerFactory()
        : new Worker(new URL('../workers/scrub.worker.ts', import.meta.url), {
            type: 'module',
          });

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (this.disposed) return;
        void this.handleMessage(event.data);
      };
      worker.onerror = (event: ErrorEvent) => {
        if (!this.disposed) {
          worker.terminate?.();
          if (this.worker === worker) {
            this.worker = null;
          }
        }
        const message = event?.message || 'Scrub worker encountered an unexpected error';
        this.rejectAllPending(new Error(message));
      };
      worker.onmessageerror = () => {
        this.rejectAllPending(new Error('Failed to deserialize message from scrub worker'));
      };

      this.worker = worker;
      return worker;
    } catch {
      this.fallbackToDirect = true;
      return null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  private async handleMessage(msg: WorkerResponse): Promise<void> {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);

    if (msg.type === 'error') {
      entry.reject(rehydrateWorkerError(msg.error));
      return;
    }

    if (msg.type === 'inspect-result' && entry.kind === 'inspect') {
      entry.resolve(msg.report);
      return;
    }

    if (msg.type === 'scrub-result' && entry.kind === 'scrub') {
      entry.resolve(msg.result);
      return;
    }

    if (
      msg.type === 'needs-main-thread-orientation' &&
      entry.kind === 'scrub'
    ) {
      try {
        const result = await completeOrientedJpegScrub(
          entry.bytes,
          msg.before,
          entry.options
        );
        entry.resolve(result);
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    entry.reject(new Error(`Unexpected worker response "${msg.type}" for "${entry.kind}" request`));
  }

  async inspect(bytes: Uint8Array): Promise<MetadataReport> {
    const worker = this.getOrCreateWorker();
    if (!worker) {
      return inspectFile(bytes);
    }

    const id = this.nextId++;
    return new Promise<MetadataReport>((resolve, reject) => {
      this.pending.set(id, { kind: 'inspect', resolve, reject });
      const request: WorkerRequest = { id, type: 'inspect', bytes };
      try {
        worker.postMessage(request);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async scrub(bytes: Uint8Array, options: ScrubOptions): Promise<ScrubResult> {
    const worker = this.getOrCreateWorker();
    if (!worker) {
      return scrubFile(bytes, options);
    }

    const id = this.nextId++;
    return new Promise<ScrubResult>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'scrub',
        bytes,
        options,
        resolve,
        reject,
      });
      const request: WorkerRequest = { id, type: 'scrub', bytes, options };
      try {
        worker.postMessage(request);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.rejectAllPending(new Error('ScrubWorkerClient disposed'));
  }
}
