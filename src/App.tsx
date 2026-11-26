import { useEffect, useState } from 'react';
import { DropZone } from './components/DropZone';
import { FileCard } from './components/FileCard';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { OptionsBar } from './components/OptionsBar';
import { useScrubQueue } from './hooks/useScrubQueue';

export function App() {
  const [isDark, setIsDark] = useState(true);
  const {
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
  } = useScrubQueue();

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Header isDark={isDark} onToggleTheme={() => setIsDark((prev) => !prev)} />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <DropZone onFilesAdded={addFiles} />

        <OptionsBar
          options={options}
          onChangeOptions={setOptions}
          totalCount={summary.total}
          readyCount={summary.readyCount}
          scrubbingCount={summary.scrubbingCount}
          scrubbedCount={summary.scrubbedCount}
          savedBytes={summary.savedBytes}
          onScrubAll={() => void scrubAll()}
          onDownloadAllZip={downloadAllZip}
          onClearAll={clearAll}
        />

        {items.length > 0 && (
          <section aria-label="Queued files" className="space-y-3">
            {items.map((item) => (
              <FileCard
                key={item.id}
                item={item}
                filenameMode={options.filenameMode}
                onScrub={(id) => void scrubItem(id)}
                onConfirmSignedScrub={(id) => void confirmSignedScrub(id)}
                onToggleSignedConfirmed={setSignedConfirmed}
                onToggleDrawer={toggleDrawer}
                onRemove={removeItem}
              />
            ))}
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}

export default App;
