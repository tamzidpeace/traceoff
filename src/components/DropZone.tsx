import { FileUp, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface DropZoneProps {
  onFilesAdded: (files: File[] | FileList) => Promise<void> | void;
}

export function DropZone({ onFilesAdded }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;

      const pastedFiles: File[] = [];
      if (clipboard.files && clipboard.files.length > 0) {
        pastedFiles.push(...Array.from(clipboard.files));
      } else if (clipboard.items) {
        for (const item of Array.from(clipboard.items)) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) pastedFiles.push(f);
          }
        }
      }

      if (pastedFiles.length > 0) {
        event.preventDefault();
        void onFilesAdded(pastedFiles);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [onFilesAdded]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
        void onFilesAdded(event.dataTransfer.files);
      }
    },
    [onFilesAdded]
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (event.target.files && event.target.files.length > 0) {
        void onFilesAdded(event.target.files);
        event.target.value = '';
      }
    },
    [onFilesAdded]
  );

  const handleLoadSample = useCallback(async () => {
    setIsLoadingSample(true);
    setSampleError(null);
    try {
      const sampleUrl = `${import.meta.env.BASE_URL}samples/sample-photo.jpg`;
      const response = await fetch(sampleUrl);
      if (!response.ok) {
        throw new Error(`Failed to load sample photo (${response.status})`);
      }
      const blob = await response.blob();
      const sampleFile = new File([blob], 'sample-photo.jpg', {
        type: 'image/jpeg',
      });
      await onFilesAdded([sampleFile]);
    } catch (err) {
      setSampleError(
        err instanceof Error ? err.message : 'Unable to load sample photo.'
      );
    } finally {
      setIsLoadingSample(false);
    }
  }, [onFilesAdded]);

  return (
    <section
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label="File upload dropzone"
      className={`rounded-2xl border-2 border-dashed p-6 text-center transition sm:p-8 ${
        isDragging
          ? 'border-emerald-500 bg-emerald-500/10'
          : 'border-zinc-300 bg-white hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-zinc-700'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
        onChange={handleFileChange}
        className="sr-only"
        aria-label="Choose images or PDF files"
      />

      <div className="mx-auto flex max-w-xl flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          <FileUp className="h-6 w-6" aria-hidden="true" />
        </div>

        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Drop photos or PDFs here to inspect &amp; scrub hidden metadata
          </h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Supports <span className="font-mono font-medium">JPEG</span>,{' '}
            <span className="font-mono font-medium">PNG</span>,{' '}
            <span className="font-mono font-medium">WebP</span>, and{' '}
            <span className="font-mono font-medium">PDF</span> · Paste images with{' '}
            <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-800">
              Ctrl/Cmd + V
            </kbd>
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          >
            <ImageIcon className="h-4 w-4" aria-hidden="true" />
            <span>Select Files</span>
          </button>

          <button
            type="button"
            onClick={() => void handleLoadSample()}
            disabled={isLoadingSample}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {isLoadingSample ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            )}
            <span>Try with Sample Photo</span>
          </button>
        </div>

        {sampleError && (
          <p role="alert" className="text-xs text-red-500 dark:text-red-400">
            {sampleError}
          </p>
        )}
      </div>
    </section>
  );
}
