# TraceOff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build TraceOff, a 100% client-side, offline-ready PWA for inspecting and scrubbing hidden metadata from JPEG, PNG, WebP, and PDF files (including deep PDF annotation and embedded JPEG image XObject scrubbing), and publish it under the `tamzidpeace` GitHub account.

**Architecture:** Pure TypeScript binary walkers (`jpegScrubber`, `pngScrubber`, `webpScrubber`) strip metadata segments/chunks losslessly inside a Web Worker, falling back to sRGB Canvas orientation baking only when EXIF `Orientation` is `2..8` and auto-orientation is enabled. PDFs are inspected and scrubbed deeply via `pdf-lib` across Info dictionaries, catalog/page XMP `/Metadata` & `/PieceInfo`, `/Annots` author/timestamp entries, and embedded `/DCTDecode` image XObjects, with every file re-inspected post-scrub to verify zero tracking tags remain.

**Tech Stack:** Vite, React 19, TypeScript (strict), Tailwind CSS, `lucide-react`, `exifr`, `pdf-lib`, `fflate`, `vite-plugin-pwa`, Vitest, React Testing Library (`jsdom`).

**Spec:** [2026-11-26-traceoff-design.md](file:///Users/arafat/Documents/Products/traceoff/docs/superpowers/specs/2026-11-26-traceoff-design.md)

## Global Constraints

- **Project Path:** `/Users/arafat/Documents/Products/traceoff` (must not touch outside workspace).
- **Git / GitHub Identity:** Repo-local `git config user.name` and `user.email` MUST belong to `tamzidpeace` (NEVER commit or push under `st-arafat`). Confirm `tamzidpeace` email and `gh` auth before the first commit/push.
- **100% Client-Side & Zero Leaks:** Zero network uploads, zero telemetry, zero external map tiles, zero external font CDNs; app must work fully offline as a PWA.
- **Permissive Licenses Only:** Only MIT / Apache-2.0 / BSD dependencies.
- **Supported v1 Formats:** JPEG, PNG, WebP, and PDF. Unsupported formats (e.g., HEIC, RAW, MP4) must fail with a clear user-facing unsupported message.
- **Base Path Portability:** Parameterize Vite `base` via `process.env.VITE_BASE_PATH ?? '/'` (CI/deploy builds GitHub Pages with `VITE_BASE_PATH=/traceoff/`; Vercel/local root uses `/`). All `public/` asset URLs must use `import.meta.env.BASE_URL`.
- **Honest Badges:** Only report `lossless` when image pixels were not re-encoded; when Canvas orientation baking runs, report `oriented-srgb` and drop wide-gamut ICC profiles.

## Review Focus

1. **Rotated smartphone JPEG (`Orientation: 2..8`) with wide-gamut ICC profile:** Must bake upright pixels in sRGB, drop ICC, and tag output as `oriented-srgb` (not `lossless`); tested in Task 3 & Task 5.
2. **Encrypted or digitally signed PDF:** Encrypted PDFs must return a clear unsupported/locked error instead of crashing; signed PDFs (`/AcroForm` `/Sig` or `/ByteRange`) must be flagged with a signature-invalidation warning; tested in Task 2 & Task 4.
3. **Malformed/truncated binary or disguised file extension (e.g., HEIC bytes named `.jpg`):** Magic-byte detection must reject non-JPEG/PNG/WebP/PDF bytes, and binary walkers must guard bounds against truncated marker/chunk lengths without infinite loops; tested in Task 1 & Task 3.
4. **WebP odd-length RIFF subchunks and `VP8X` feature bits:** Dropping `EXIF`, `XMP `, or `ICCP` must respect 2-byte RIFF padding, clear the exact `VP8X` bit flags (`0x08`, `0x04`, `0x20`), and recalculate the outer RIFF file size; tested in Task 3.
5. **Duplicate filenames in batch ZIP export:** Two files named `photo.jpg` must be deduplicated (`photo.jpg`, `photo (1).jpg`) instead of colliding in `fflate`; tested in Task 5.

---

### Task 1: Project Scaffolding, Git Guard, Types & Magic-Byte Format Detection

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/index.css`, `src/main.tsx`, `src/App.tsx`
- Create: `src/core/types.ts`
- Create: `src/core/detectFormat.ts`
- Create: `tests/detectFormat.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `SupportedFormat = 'jpeg' | 'png' | 'webp' | 'pdf'`
  - `RiskLevel = 'high' | 'medium' | 'clean'`
  - `ScrubMode = 'lossless' | 'oriented-srgb' | 'pdf-deep' | 'already-clean'`
  - `MetadataField`, `MetadataReport`, `ScrubOptions`, `ScrubResult` in `src/core/types.ts`
  - `detectFormat(bytes: Uint8Array): SupportedFormat | null` in `src/core/detectFormat.ts`

- [ ] **Step 1: Initialize git repo with `tamzidpeace` identity & scaffold Vite + React + TS + Tailwind + Vitest**
  Run `git init` inside `/Users/arafat/Documents/Products/traceoff`, verify/ask `tamzidpeace` git `user.email`, set `git config --local user.name "tamzidpeace"` and `git config --local user.email "<tamzidpeace-email>"`, and scaffold `package.json` with dependencies (`react`, `react-dom`, `lucide-react`, `exifr`, `pdf-lib`, `fflate`) and devDependencies (`vite`, `@vitejs/plugin-react`, `vite-plugin-pwa`, `tailwindcss`, `@tailwindcss/vite`, `typescript`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@types/react`, `@types/react-dom`). Configure `vite.config.ts` with `base: process.env.VITE_BASE_PATH ?? '/'` and `VitePWA` deriving `start_url` and `scope` from that `base`.
  Verify: `npm run typecheck` passes on starter files.

- [ ] **Step 2: Define core domain types in `src/core/types.ts`**
  Define:
  - `SupportedFormat = 'jpeg' | 'png' | 'webp' | 'pdf'`
  - `MetadataCategory = 'location' | 'device' | 'author' | 'dates' | 'pdf-embedded' | 'other'`
  - `MetadataField { key: string; label: string; value: string; category: MetadataCategory; sensitive: boolean }`
  - `MetadataReport { format: SupportedFormat; riskLevel: RiskLevel; hasGps: boolean; orientation: number | null; hasIccProfile: boolean; isSignedPdf: boolean; embeddedImageWithMetaCount: number; fields: MetadataField[]; totalTags: number }`
  - `ScrubOptions { preserveIcc: boolean; autoFixOrientation: boolean; allowSignedPdfScrub: boolean; filenameMode: 'suffix' | 'original' }`
  - `ScrubResult { format: SupportedFormat; cleanBytes: Uint8Array; mode: ScrubMode; before: MetadataReport; after: MetadataReport; originalSize: number; cleanSize: number; warnings: string[] }`

- [ ] **Step 3: Write failing tests for `detectFormat` in `tests/detectFormat.test.ts`**
  ```ts
  import { describe, it, expect } from 'vitest';
  import { detectFormat } from '../src/core/detectFormat';

  describe('detectFormat', () => {
    it('detects JPEG magic bytes', () => {
      expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    });
    it('detects PNG magic bytes', () => {
      expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    });
    it('detects WebP RIFF/WEBP magic bytes', () => {
      const webp = new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBP');
      expect(detectFormat(webp)).toBe('webp');
    });
    it('detects PDF magic bytes (including leading whitespace/BOM)', () => {
      expect(detectFormat(new TextEncoder().encode('%PDF-1.7\n'))).toBe('pdf');
    });
    it('returns null for disguised HEIC/ftyp or truncated inputs', () => {
      expect(detectFormat(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
      expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
    });
  });
  ```

- [ ] **Step 4: Run test to verify it fails**
  Run: `npx vitest run tests/detectFormat.test.ts`
  Expected: FAIL with missing `detectFormat`.

- [ ] **Step 5: Implement `detectFormat(bytes: Uint8Array): SupportedFormat | null` in `src/core/detectFormat.ts`**
  Check exact magic signatures (JPEG `FF D8 FF`, PNG 8-byte signature, WebP `RIFF....WEBP` >= 12 bytes, PDF `%PDF-` within first 1024 bytes to match PDF spec).

- [ ] **Step 6: Run tests and commit**
  Run: `npx vitest run tests/detectFormat.test.ts && npm run typecheck`
  Expected: PASS.
  ```bash
  git add -A && git commit -m "chore: scaffold TraceOff app, core types, and magic-byte format detection"
  ```

---

### Task 2: Synthetic Test Fixtures & Metadata Inspectors (`inspectImage`, `inspectPdf`)

**Files:**
- Create: `tests/helpers/fixtures.ts`
- Create: `src/core/inspector/inspectImage.ts`
- Create: `src/core/inspector/inspectPdf.ts`
- Create: `tests/inspectors.test.ts`

**Interfaces:**
- Consumes: `SupportedFormat`, `MetadataReport`, `MetadataField`, `RiskLevel` from `src/core/types.ts`
- Produces:
  - `inspectImage(bytes: Uint8Array, format: 'jpeg' | 'png' | 'webp'): Promise<MetadataReport>`
  - `inspectPdf(bytes: Uint8Array): Promise<MetadataReport>` (throws typed `PdfInspectError('encrypted', ...)` on encrypted PDFs)
  - Test fixture builders in `tests/helpers/fixtures.ts`: `buildJpegWithExif(opts)`, `buildPngWithMeta(opts)`, `buildWebpWithMeta(opts)`, `buildPdfWithDeepMeta(opts)`

- [ ] **Step 1: Write synthetic binary fixture builders in `tests/helpers/fixtures.ts`**
  Implement pure-TS builders creating minimal valid binaries:
  - `buildJpegWithExif({ gps?: [number, number]; make?: string; orientation?: number; xmp?: string; icc?: boolean; comment?: string })` (valid SOI + APP1 TIFF/EXIF IFD0+GPS IFD + optional APP1 XMP + optional APP2 ICC + optional COM + minimal SOF0/DHT/DQT/SOS/EOI so both `exifr` and `createImageBitmap`/browsers parse it as a real 2x2 JPEG).
  - `buildPngWithMeta({ exif?: Uint8Array; text?: Record<string, string>; iccp?: boolean })` (valid PNG signature + IHDR + optional iCCP/eXIf/tEXt/iTXt/tIME + IDAT + IEND with valid CRC32).
  - `buildWebpWithMeta({ exif?: Uint8Array; xmp?: string; iccp?: boolean })` (valid RIFF/WEBP with VP8X + VP8/VP8L + optional ICCP/EXIF/XMP chunks and even/odd padding).
  - `buildPdfWithDeepMeta({ author?: string; xmp?: string; annotAuthor?: string; embeddedJpeg?: Uint8Array; signed?: boolean })` (built with `pdf-lib` low-level PDF objects so all Info, XMP, `/Annots`, `/PieceInfo`, embedded `/DCTDecode` JPEG XObject, and `/ByteRange`/`/Sig` cases are real).

- [ ] **Step 2: Write failing tests in `tests/inspectors.test.ts`**
  Assert:
  - `inspectImage` on `buildJpegWithExif({ gps: [23.8103, 90.4125], make: 'Apple', orientation: 6, icc: true })` returns `hasGps: true`, `riskLevel: 'high'`, `orientation: 6`, `hasIccProfile: true`, and fields covering GPS + Make.
  - `inspectImage` on `buildPngWithMeta({ text: { Software: 'Photoshop' } })` returns `riskLevel: 'medium'` and finds `Software`.
  - `inspectPdf` on `buildPdfWithDeepMeta({ author: 'Arafat', xmp: '<x:xmpmeta>...</x:xmpmeta>', annotAuthor: 'Reviewer', embeddedJpeg })` returns `riskLevel: 'high'`, `hasGps: true`, `embeddedImageWithMetaCount: 1`, and lists Author, XMP, Annotation Author, and Embedded Image GPS/Make.
  - `inspectPdf` on `{ signed: true }` sets `isSignedPdf: true`.
  - `inspectPdf` on encrypted PDF bytes throws `PdfInspectError` with code `'encrypted'`.

- [ ] **Step 3: Run tests to verify failure**
  Run: `npx vitest run tests/inspectors.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 4: Implement `inspectImage` and `inspectPdf`**
  - `src/core/inspector/inspectImage.ts`: Use `exifr.parse(bytes, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: true, ifd0: true })` plus lightweight chunk/marker fallback check (for PNG `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME` and JPEG `COM` markers that `exifr` may skip) so zero hidden text/comment chunks go unreported.
  - `src/core/inspector/inspectPdf.ts`: Load via `PDFDocument.load(bytes, { updateMetadata: false })` catching encryption errors -> `PdfInspectError('encrypted', ...)`. Inspect Info dict, catalog/page `/Metadata` & `/PieceInfo`, page `/Annots` (`/T`, `/Subj`, `/CreationDate`, `/M`), `/AcroForm` `/Sig` or `/ByteRange`, and indirect `/Subtype /Image` streams (inspecting `/DCTDecode` streams via `inspectImage(..., 'jpeg')` and checking XObject `/Metadata` refs).

- [ ] **Step 5: Run tests to verify pass and commit**
  Run: `npx vitest run tests/inspectors.test.ts && npm run typecheck`
  Expected: PASS.
  ```bash
  git add tests/ src/core/inspector/ && git commit -m "feat: add image and deep PDF metadata inspectors with synthetic fixtures"
  ```

---

### Task 3: Lossless Image Scrubbers (`jpegScrubber`, `pngScrubber`, `webpScrubber`) & `canvasFallback`

**Files:**
- Create: `src/core/scrubbers/jpegScrubber.ts`
- Create: `src/core/scrubbers/pngScrubber.ts`
- Create: `src/core/scrubbers/webpScrubber.ts`
- Create: `src/core/scrubbers/canvasFallback.ts`
- Create: `tests/imageScrubbers.test.ts`

**Interfaces:**
- Consumes: `MetadataReport` (for orientation check)
- Produces:
  - `scrubJpegLossless(bytes: Uint8Array, options: { preserveIcc: boolean }): Uint8Array`
  - `scrubPngLossless(bytes: Uint8Array, options: { preserveIcc: boolean }): Uint8Array`
  - `scrubWebpLossless(bytes: Uint8Array, options: { preserveIcc: boolean }): Uint8Array`
  - `bakeOrientedImageCanvas(bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png' | 'image/webp'): Promise<Uint8Array>`

- [ ] **Step 1: Write failing tests in `tests/imageScrubbers.test.ts`**
  Cover all core paths + Review Focus items:
  - **JPEG lossless:** Strips `APP1` (EXIF + XMP), `APP13`, `COM`; preserves `APP0`, `APP14` (if present), `APP2` ICC only when `preserveIcc: true`; preserves exact `SOS` scan payload bytes (`byte-for-byte identical` entropy stream); re-running `inspectImage` yields `totalTags === 0`.
  - **PNG lossless:** Strips `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`; keeps `IHDR`, `IDAT` (byte-identical), `IEND`, and `iCCP` only when `preserveIcc: true`; validates chunk CRC32.
  - **WebP lossless:** Strips `EXIF` and `XMP ` (odd & even byte lengths), strips `ICCP` when `preserveIcc: false`, clears `VP8X` bits (`0x08`, `0x04`, and `0x20` when ICC stripped), updates RIFF total size, and passes `inspectImage` with `totalTags === 0`.
  - **Malformed/truncated input:** Truncated JPEG segment length or truncated PNG chunk length throws descriptive `Error` instead of hanging or returning corrupt output.
  - **Canvas orientation fallback:** Mock/test `bakeOrientedImageCanvas` behavior (via `OffscreenCanvas` / `createImageBitmap` stub in `jsdom` or unit contract test) confirming output drops ICC and calls `convertToBlob({ type: 'image/jpeg', quality: 0.95 })`.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run tests/imageScrubbers.test.ts`
  Expected: FAIL with missing scrubber modules.

- [ ] **Step 3: Implement `jpegScrubber.ts`, `pngScrubber.ts`, `webpScrubber.ts`, and `canvasFallback.ts`**
  - `jpegScrubber.ts`: Validate `0xFF 0xD8` SOI, walk segments up to `0xFF 0xDA` (SOS) where remaining bytes up to `0xFF 0xD9` (EOI) are copied verbatim; validate every length `>= 2` and `offset + length <= bytes.length`.
  - `pngScrubber.ts`: Validate 8-byte signature, walk chunks validating bounds (`offset + 12 + len <= bytes.length`), drop `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`, and `iCCP` (when `!preserveIcc`).
  - `webpScrubber.ts`: Parse `RIFF` + uint32 LE size + `WEBP`, iterate chunks with `(chunkSize + 1) & ~1` padded advance, drop `EXIF`, `XMP `, and `ICCP` (when `!preserveIcc`), patch `VP8X` flags byte (`flags &= ~(0x08 | 0x04 | (!preserveIcc ? 0x20 : 0))`), rewrite outer RIFF size.
  - `canvasFallback.ts`: Use `createImageBitmap(blob, { imageOrientation: 'from-image' })` + `OffscreenCanvas` (falling back to DOM `HTMLCanvasElement` on older Safari workers/main thread).

- [ ] **Step 4: Run tests to verify pass and commit**
  Run: `npx vitest run tests/imageScrubbers.test.ts && npm run typecheck`
  Expected: PASS.
  ```bash
  git add src/core/scrubbers/ tests/imageScrubbers.test.ts && git commit -m "feat: implement lossless JPEG/PNG/WebP scrubbers and orientation Canvas fallback"
  ```

---

### Task 4: Deep PDF Scrubber (`pdfScrubber.ts`)

**Files:**
- Create: `src/core/scrubbers/pdfScrubber.ts`
- Create: `tests/pdfScrubber.test.ts`

**Interfaces:**
- Consumes: `scrubJpegLossless` from `src/core/scrubbers/jpegScrubber.ts`, `PdfInspectError` from `src/core/inspector/inspectPdf.ts`
- Produces:
  - `scrubPdfDeep(bytes: Uint8Array, options: { preserveIcc: boolean; allowSignedPdfScrub: boolean }): Promise<{ cleanBytes: Uint8Array; warnings: string[] }>`

- [ ] **Step 1: Write failing tests in `tests/pdfScrubber.test.ts`**
  Using `buildPdfWithDeepMeta` and `inspectPdf`:
  - Clears `Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer` (including preventing `pdf-lib` default producer), `CreationDate`, `ModDate`.
  - Deletes catalog & page `/Metadata` (XMP) and `/PieceInfo`.
  - Clears `/Annots` author (`/T`), subject (`/Subj`), `/CreationDate`, `/M`.
  - Scrubs embedded `/DCTDecode` JPEG XObject stream using `scrubJpegLossless`, leaving `inspectPdf(cleanBytes)` with `totalTags === 0`, `hasGps === false`, `embeddedImageWithMetaCount === 0`, while keeping PDF valid/loadable by `pdf-lib`.
  - Rejects signed PDF when `allowSignedPdfScrub: false` with `PdfScrubError('signed-confirmation-required')`, and scrubs + returns signature-invalidated warning when `allowSignedPdfScrub: true`.
  - Rejects encrypted PDF with `PdfInspectError('encrypted')`.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run tests/pdfScrubber.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `scrubPdfDeep` in `src/core/scrubbers/pdfScrubber.ts`**
  Load with `PDFDocument.load(bytes, { updateMetadata: false })`, detect signatures, delete Info dict entry or blank all standard fields + clear `Producer` right before/via `PDFDocument` catalog/trailer, delete `/Metadata` & `/PieceInfo` on catalog, pages, and XObjects, sanitize `/Annots`, rewrite `/DCTDecode` `PDFRawStream` contents via `scrubJpegLossless` updating `/Length`, and save with `{ useObjectStreams: false }` or standard `save({ updateFieldAppearances: false })` while ensuring `Producer` is not re-populated (remove `/Info` ref from `pdfDoc.context.trailerInfo` cleanly!).

- [ ] **Step 4: Run tests to verify pass and commit**
  Run: `npx vitest run tests/pdfScrubber.test.ts && npm run typecheck`
  Expected: PASS.
  ```bash
  git add src/core/scrubbers/pdfScrubber.ts tests/pdfScrubber.test.ts && git commit -m "feat: implement deep PDF metadata, annotation, and embedded JPEG scrubber"
  ```

---

### Task 5: Unified `scrubFile`, Collision-Safe ZIP Export, Web Worker & Sample Photo

**Files:**
- Create: `src/core/scrubFile.ts`
- Create: `src/core/zipExport.ts`
- Create: `src/workers/scrub.worker.ts`
- Create: `src/core/workerClient.ts`
- Create: `public/samples/sample-photo.jpg` (tiny synthetic JPEG with safe dummy Dhaka GPS + camera EXIF, generated via a 1-off build helper or script)
- Create: `tests/scrubFile.test.ts`
- Create: `tests/zipExport.test.ts`

**Interfaces:**
- Consumes: `detectFormat`, `inspectImage`, `inspectPdf`, all scrubbers
- Produces:
  - `inspectFile(bytes: Uint8Array): Promise<MetadataReport>`
  - `scrubFile(bytes: Uint8Array, options: ScrubOptions): Promise<ScrubResult>`
  - `buildZipArchive(entries: Array<{ name: string; bytes: Uint8Array }>): Uint8Array`
  - `ScrubWorkerClient` in `src/core/workerClient.ts`

- [ ] **Step 1: Write failing tests in `tests/scrubFile.test.ts` and `tests/zipExport.test.ts`**
  - `scrubFile` end-to-end: inspects, scrubs, re-inspects `after`, sets `mode: 'lossless'` for normal JPEG/PNG/WebP, `mode: 'oriented-srgb'` when JPEG `Orientation === 6` and `autoFixOrientation: true`, `mode: 'pdf-deep'` for PDF, `mode: 'already-clean'` when `before.totalTags === 0`.
  - `buildZipArchive`: compresses multiple files and deduplicates identical filenames (`photo.jpg`, `photo (1).jpg`, `photo (2).jpg`), verifiable with `fflate.unzipSync`.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run tests/scrubFile.test.ts tests/zipExport.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `scrubFile.ts`, `zipExport.ts`, `scrub.worker.ts`, `workerClient.ts`, and generate `public/samples/sample-photo.jpg`**
  Note: If `OffscreenCanvas` is unavailable inside the worker in older Safari when orientation `2..8` is encountered, have `scrub.worker.ts` support returning a flag or falling back cleanly to `workerClient` main-thread `canvasFallback.ts` so Safari works reliably!

- [ ] **Step 4: Run full core test suite and commit**
  Run: `npx vitest run && npm run typecheck`
  Expected: All core tests PASS.
  ```bash
  git add src/core/ src/workers/ public/samples/ tests/ && git commit -m "feat: add unified scrubFile pipeline, Web Worker bridge, ZIP export, and sample photo"
  ```

---

### Task 6: Privacy-First Frontend UI, Queue Hook, PWA Icons & UI Tests

**Files:**
- Create: `public/icons/icon-192.png`, `public/icons/icon-512.png`
- Create: `src/hooks/useScrubQueue.ts`
- Create: `src/components/Header.tsx`
- Create: `src/components/DropZone.tsx`
- Create: `src/components/OptionsBar.tsx`
- Create: `src/components/FileCard.tsx`
- Create: `src/components/MetadataDrawer.tsx`
- Create: `src/components/Footer.tsx`
- Modify: `src/App.tsx`, `src/index.css`, `index.html`
- Create: `tests/App.test.tsx`

**Interfaces:**
- Consumes: `ScrubWorkerClient`, `buildZipArchive`, `ScrubOptions`, `ScrubResult`, `MetadataReport`
- Produces: Complete interactive TraceOff web application + PWA

- [ ] **Step 1: Write failing UI tests in `tests/App.test.tsx`**
  Using `@testing-library/react` (mocking `ScrubWorkerClient` cleanly):
  - Renders privacy banner ("100% Local Processing") and DropZone with "Try with Sample Photo" button.
  - Uploading a file displays risk badge + leaked GPS/camera/author count; clicking "Inspect Metadata" opens Before/After table without making any `fetch` call to external origins (assert `fetch` is never called with file metadata/GPS).
  - Clicking "Scrub All Files" transitions card to `Verified Clean: 0 tracking tags remaining`, shows `Lossless` vs `Oriented & Scrubbed (sRGB)` badge accurately, enables single download & "Download All (.zip)" when 2+ scrubbed files exist.
  - Digitally signed PDF displays confirmation prompt/toggle before scrubbing.
  - Clicking "Clear All" removes items and calls `URL.revokeObjectURL`.

- [ ] **Step 2: Run UI tests to verify failure**
  Run: `npx vitest run tests/App.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implement UI components, `useScrubQueue`, styling, and PWA icons**
  - Clean, modern privacy-utility UI (dark mode default with light mode toggle, crisp monospace data readouts for coordinates/hashes/sizes, high-contrast status badges).
  - Fetch sample photo via `` `${import.meta.env.BASE_URL}samples/sample-photo.jpg` `` so `/traceoff/` GitHub Pages subpath works identically to `/` Vercel/local.
  - Zero external CDN links in `index.html` or CSS.

- [ ] **Step 4: Run all tests, typecheck, and production build; commit**
  Run: `npx vitest run && npm run typecheck && VITE_BASE_PATH=/traceoff/ npm run build`
  Expected: All tests PASS, zero TS errors, clean `dist/` bundle with service worker & manifest scoped to `/traceoff/`.
  ```bash
  git add public/icons/ src/ index.html tests/App.test.tsx && git commit -m "feat: build TraceOff UI, queue hook, metadata inspector drawer, and PWA assets"
  ```

---

### Task 7: Open-Source Docs, CI/CD Workflows & Publish to `tamzidpeace/traceoff`

**Files:**
- Create: `README.md`
- Create: `LICENSE` (MIT, `tamzidpeace`)
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`
- Create: `.gitignore`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Published `tamzidpeace/traceoff` GitHub repository & GitHub Pages deployment workflow

- [ ] **Step 1: Add `README.md`, `LICENSE` (MIT), `.gitignore`, and GitHub Actions workflows**
  - `README.md`: Clear project pitch, privacy architecture diagram/explanation (Lossless JPEG/PNG/WebP + Deep PDF XObject scrubbing), supported formats, local dev commands, and Vercel/GitHub Pages deploy instructions.
  - `.github/workflows/ci.yml`: Runs `npm ci`, `npm run typecheck`, `npx vitest run`, and `npm run build` on PRs and pushes.
  - `.github/workflows/deploy.yml`: Builds with `VITE_BASE_PATH=/traceoff/` on push to `main` and deploys `dist/` via `actions/upload-pages-artifact` + `actions/deploy-pages`.

- [ ] **Step 2: Run final verification suite**
  Run: `npx vitest run && npm run typecheck && VITE_BASE_PATH=/traceoff/ npm run build`
  Expected: PASS with 0 errors.

- [ ] **Step 3: Verify `tamzidpeace` git identity & GitHub CLI auth, commit, create repo, and push**
  - Verify `git log --format="%an <%ae>"` shows ONLY `tamzidpeace` (never `st-arafat`).
  - Check `gh auth status` (if currently logged in as `st-arafat` or `gh` is blocked, pause and ask user to switch `gh auth` to `tamzidpeace` before pushing).
  - Create public repo `tamzidpeace/traceoff` (if needed), push `main`, and verify GitHub Pages workflow status.

---

## Self-Review Check (Completed)
- **Spec Coverage:** Covers all v1 formats (JPEG, PNG, WebP, deep PDF), orientation vs. ICC handling, zero external requests, sample photo, batch ZIP, Before/After verification, `VITE_BASE_PATH=/traceoff/` GH Pages + Vercel portability, and `tamzidpeace` git isolation.
- **Type Consistency:** `SupportedFormat`, `RiskLevel`, `ScrubMode`, `MetadataReport`, `ScrubOptions`, `ScrubResult` are shared consistently across Tasks 1–6.
- **Review Focus Pinned:** All 5 high-risk edge cases (rotated P3 JPEG, signed/encrypted PDF, malformed/disguised files, WebP `VP8X`/odd padding, duplicate ZIP filenames) have explicit failing-first tests in Tasks 1–5.
