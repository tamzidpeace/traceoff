import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PdfInspectError } from '../core/inspector/inspectPdf';
import { UnsupportedFormatError } from '../core/scrubFile';
import { PdfScrubError } from '../core/scrubbers/pdfScrubber';
import type { MetadataReport, ScrubOptions, ScrubResult } from '../core/types';
import { ScrubWorkerClient } from '../core/workerClient';
import { buildZipArchive } from '../core/zipExport';
import { getCleanFilename, mimeTypeForFormat, triggerBlobDownload } from '../utils/format';

export type QueueItemStatus =
  | 'inspecting'
  | 'ready'
  | 'scrubbing'
  | 'scrubbed'
  | 'error';

export interface QueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  bytes: Uint8Array | null;
  previewUrl: string | null;
  cleanUrl: string | null;
  status: QueueItemStatus;
  report: MetadataReport | null;
  result: ScrubResult | null;
  error: string | null;
  signedConfirmed: boolean;
  drawerOpen: boolean;
}

const DEFAULT_OPTIONS: ScrubOptions = {
  preserveIcc: true,
  autoFixOrientation: true,
  allowSignedPdfScrub: false,
  filenameMode: 'suffix',
};

function isLikelyImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp)$/i.test(file.name);
}

function revokeItemUrls(item: Pick<QueueItem, 'previewUrl' | 'cleanUrl'>): void {
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
  if (item.cleanUrl) {
    URL.revokeObjectURL(item.cleanUrl);
  }
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof PdfInspectError) {
    return err.message;
  }
  if (err instanceof UnsupportedFormatError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function useScrubQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [options, setOptions] = useState<ScrubOptions>(DEFAULT_OPTIONS);

  const clientRef = useRef<ScrubWorkerClient | null>(null);
  const itemsRef = useRef<QueueItem[]>(items);
  const optionsRef = useRef<ScrubOptions>(options);
  const idCounterRef = useRef(0);
  const mountedRef = useRef(true);

  itemsRef.current = items;
  optionsRef.current = options;

  const getClient = useCallback((): ScrubWorkerClient => {
    if (!clientRef.current) {
      clientRef.current = new ScrubWorkerClient();
    }
    return clientRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const item of itemsRef.current) {
        revokeItemUrls(item);
      }
      if (clientRef.current) {
        clientRef.current.dispose();
        clientRef.current = null;
      }
    };
  }, []);

  const addFiles = useCallback(
    async (fileList: File[] | FileList) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;

      const newItems: QueueItem[] = incoming.map((file) => {
        const id = `traceoff-${Date.now()}-${++idCounterRef.current}`;
        const previewUrl = isLikelyImageFile(file) ? URL.createObjectURL(file) : null;
        return {
          id,
          file,
          name: file.name,
          size: file.size,
          bytes: null,
          previewUrl,
          cleanUrl: null,
          status: 'inspecting',
          report: null,
          result: null,
          error: null,
          signedConfirmed: false,
          drawerOpen: false,
        };
      });

      itemsRef.current = [...itemsRef.current, ...newItems];
      setItems((prev) => [...prev, ...newItems]);

      await Promise.all(
        newItems.map(async (entry) => {
          try {
            const buffer = await entry.file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const report = await getClient().inspect(bytes);

            const current = itemsRef.current.find((item) => item.id === entry.id);
            if (!mountedRef.current || !current) return;

            let previewUrl = current.previewUrl;
            if (report.format === 'pdf') {
              if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
                previewUrl = null;
              }
            } else if (!previewUrl) {
              previewUrl = URL.createObjectURL(current.file);
            }

            itemsRef.current = itemsRef.current.map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    bytes,
                    previewUrl,
                    status: 'ready',
                    report,
                    error: null,
                  }
                : item
            );
            setItems((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      bytes,
                      previewUrl,
                      status: 'ready',
                      report,
                      error: null,
                    }
                  : item
              )
            );
          } catch (err) {
            const current = itemsRef.current.find((item) => item.id === entry.id);
            if (!mountedRef.current || !current) {
              return;
            }
            if (current.previewUrl) {
              URL.revokeObjectURL(current.previewUrl);
            }
            const errorMessage = formatErrorMessage(err);
            itemsRef.current = itemsRef.current.map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    previewUrl: null,
                    status: 'error',
                    error: errorMessage,
                  }
                : item
            );
            setItems((prev) =>
              prev.map((item) => {
                if (item.id !== entry.id) return item;
                return {
                  ...item,
                  previewUrl: null,
                  status: 'error',
                  error: errorMessage,
                };
              })
            );
          }
        })
      );
    },
    [getClient]
  );

  const scrubItem = useCallback(
    async (id: string, overrideAllowSigned = false) => {
      const target = itemsRef.current.find((item) => item.id === id);
      if (!target || !target.bytes || !target.report || target.status === 'scrubbing') return;

      const currentOptions = optionsRef.current;
      const allowSigned =
        overrideAllowSigned || target.signedConfirmed || currentOptions.allowSignedPdfScrub;

      if (target.report.isSignedPdf && !allowSigned) {
        return;
      }

      itemsRef.current = itemsRef.current.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'scrubbing',
              error: null,
            }
          : item
      );
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'scrubbing',
                error: null,
              }
            : item
        )
      );

      try {
        const result = await getClient().scrub(target.bytes, {
          ...currentOptions,
          allowSignedPdfScrub: allowSigned,
        });

        if (!mountedRef.current || !itemsRef.current.some((entry) => entry.id === id)) {
          return;
        }

        const cleanBlob = new Blob([new Uint8Array(result.cleanBytes)], {
          type: mimeTypeForFormat(result.format),
        });
        const nextCleanUrl = URL.createObjectURL(cleanBlob);

        const currentItem = itemsRef.current.find((item) => item.id === id);
        if (!mountedRef.current || !currentItem) {
          URL.revokeObjectURL(nextCleanUrl);
          return;
        }
        if (currentItem.cleanUrl) {
          URL.revokeObjectURL(currentItem.cleanUrl);
        }

        itemsRef.current = itemsRef.current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'scrubbed',
                result,
                cleanUrl: nextCleanUrl,
                error: null,
              }
            : item
        );
        setItems((prev) =>
          prev.map((item) => {
            if (item.id !== id) return item;
            if (item.cleanUrl && item.cleanUrl !== currentItem.cleanUrl) {
              URL.revokeObjectURL(item.cleanUrl);
            }
            return {
              ...item,
              status: 'scrubbed',
              result,
              cleanUrl: nextCleanUrl,
              error: null,
            };
          })
        );
      } catch (err) {
        if (!mountedRef.current || !itemsRef.current.some((entry) => entry.id === id)) {
          return;
        }

        const isSignedErr =
          err instanceof PdfScrubError ||
          (typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: string }).code === 'signed-confirmation-required');

        if (isSignedErr) {
          itemsRef.current = itemsRef.current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'ready',
                  signedConfirmed: false,
                }
              : item
          );
          setItems((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status: 'ready',
                    signedConfirmed: false,
                  }
                : item
            )
          );
          return;
        }

        const errorMessage = formatErrorMessage(err);
        itemsRef.current = itemsRef.current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'error',
                error: errorMessage,
              }
            : item
        );
        setItems((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'error',
                  error: errorMessage,
                }
              : item
          )
        );
      }
    },
    [getClient]
  );

  const confirmSignedScrub = useCallback(
    async (id: string) => {
      const target = itemsRef.current.find((item) => item.id === id);
      if (!target || target.status === 'scrubbing') return;

      itemsRef.current = itemsRef.current.map((item) =>
        item.id === id
          ? { ...item, signedConfirmed: true }
          : item
      );
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, signedConfirmed: true }
            : item
        )
      );
      await scrubItem(id, true);
    },
    [scrubItem]
  );

  const setSignedConfirmed = useCallback((id: string, confirmed: boolean) => {
    itemsRef.current = itemsRef.current.map((item) =>
      item.id === id
        ? {
            ...item,
            signedConfirmed: confirmed,
          }
        : item
    );
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              signedConfirmed: confirmed,
            }
          : item
      )
    );
  }, []);

  const scrubAll = useCallback(async () => {
    const readyItems = itemsRef.current.filter((item) => item.status === 'ready');
    await Promise.all(readyItems.map((item) => scrubItem(item.id)));
  }, [scrubItem]);

  const toggleDrawer = useCallback((id: string) => {
    itemsRef.current = itemsRef.current.map((item) =>
      item.id === id ? { ...item, drawerOpen: !item.drawerOpen } : item
    );
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, drawerOpen: !item.drawerOpen } : item
      )
    );
  }, []);

  const removeItem = useCallback((id: string) => {
    const target = itemsRef.current.find((item) => item.id === id);
    if (target) {
      revokeItemUrls(target);
    }
    itemsRef.current = itemsRef.current.filter((item) => item.id !== id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    for (const item of itemsRef.current) {
      revokeItemUrls(item);
    }
    itemsRef.current = [];
    setItems([]);
  }, []);

  const downloadAllZip = useCallback(() => {
    const scrubbed = itemsRef.current.filter(
      (item): item is QueueItem & { result: ScrubResult } =>
        item.status === 'scrubbed' && item.result !== null
    );
    if (scrubbed.length === 0) return;

    const entries = scrubbed.map((item) => ({
      name: getCleanFilename(item.name, optionsRef.current.filenameMode),
      bytes: item.result.cleanBytes,
    }));

    const zipBytes = buildZipArchive(entries);
    triggerBlobDownload(zipBytes, 'traceoff-clean-files.zip', 'application/zip');
  }, []);

  const summary = useMemo(() => {
    const total = items.length;
    const readyCount = items.filter((i) => i.status === 'ready').length;
    const scrubbingCount = items.filter(
      (i) => i.status === 'inspecting' || i.status === 'scrubbing'
    ).length;
    const scrubbedCount = items.filter((i) => i.status === 'scrubbed').length;
    const savedBytes = items.reduce((acc, i) => {
      if (i.status === 'scrubbed' && i.result) {
        return acc + Math.max(0, i.result.originalSize - i.result.cleanSize);
      }
      return acc;
    }, 0);
    return {
      total,
      readyCount,
      scrubbingCount,
      scrubbedCount,
      savedBytes,
    };
  }, [items]);

  return {
    items,
    options,
    setOptions,
    summary,
    addFiles,
    scrubItem,
    confirmSignedScrub,
    setSignedConfirmed,
    scrubAll,
    toggleDrawer,
    removeItem,
    clearAll,
    downloadAllZip,
  };
}
