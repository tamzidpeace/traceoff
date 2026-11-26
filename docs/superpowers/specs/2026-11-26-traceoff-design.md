# TraceOff — Design Document

**Date:** 2026-11-26  
**Project Folder:** `/Users/arafat/Documents/Products/traceoff`  
**GitHub Account / Owner:** `tamzidpeace` (repo-local git config must be set to `tamzidpeace`, never `st-arafat`)  
**Catalog Reference:** `#005` Metadata Scrubber (`Curious Arafat — Open-Source Software Ideas Master Bank`)

---

## 1. Intent & Why

Everyday photos and PDF documents silently embed sensitive metadata: exact GPS coordinates (home/work location), camera/phone model, serial numbers, editing software, creation timestamps, author names, and hidden XMP XML streams. Most online "EXIF remover" sites require uploading those very private files to an unknown third-party server—defeating the entire purpose of privacy.

**TraceOff** solves this with a zero-upload, 100% client-side web application (and installable offline PWA). Users drop images or PDFs into their browser, immediately see what sensitive metadata each file is leaking, scrub all traces locally with lossless binary stripping (where possible), verify that zero metadata remains, and download clean files—individually or as a batch ZIP.

It is also designed as an open-source showcase project for GitHub (`tamzidpeace`) and the `@curious-arafat` YouTube channel (*"Your Photos Leak Your Home Location — Free Fix"*).

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **100% Client-Side Privacy:** Every inspection and scrubbing operation runs strictly inside the user's browser (main thread + Web Workers). Zero network uploads, zero analytics/tracking scripts, zero third-party API calls (including no external map tiles or reverse-geocoding lookups with user GPS coordinates).
- **Images + Deep PDFs Support (v1):**
  - **Images:** JPEG/JPG, PNG, and WebP.
  - **PDFs:** Standard `.pdf` documents — document-level metadata (Info dictionary, XMP `/Metadata`, `/PieceInfo`), page-level `/Metadata` & `/PieceInfo`, annotation author/timestamp metadata (`/Annots`), and EXIF/XMP metadata inside embedded JPEG image XObjects (`/DCTDecode`).
- **Show Before & Verify After:** Parse and display leaked metadata before scrubbing (grouped cleanly: Location/GPS, Device/Camera, Author/Software, Dates, Embedded PDF Images/Annotations, Raw/Other Tags), and run a post-scrub verification pass confirming 0 tracking tags remain.
- **Lossless First:** Strip metadata from JPEG, PNG, and WebP (and embedded PDF JPEG XObjects) at the binary marker/chunk level so image pixels are **not** re-compressed or degraded.
- **Orientation-Safe Photos:** Automatically handle EXIF `Orientation` tags (`!= 1`) on JPEGs so portrait phone photos never turn sideways after EXIF removal.
- **Batch Processing & ZIP Export:** Support dropping multiple mixed files (images + PDFs) at once, tracking per-file progress in a Web Worker, and offering a 1-click "Download All (.zip)" alongside single-file downloads.
- **Offline-Ready PWA & GitHub Pages Hosting:** Build as a static site + PWA (`vite-plugin-pwa`) configured primarily for GitHub Pages (`https://tamzidpeace.github.io/traceoff/` at `/traceoff/`) with `VITE_BASE_PATH` parameterization so root-path Vercel/Cloudflare Pages deploys work cleanly too.
- **Open-Source Readiness:** Clean MIT-licensed repository, thorough `README.md`, automated binary-level verification tests, and clean GitHub Actions CI.

### Non-Goals (Out of Scope for v1)
- Video or audio metadata scrubbing (e.g., MP4/MOV/MP3 — separate future tool or v2).
- HEIC/RAW/TIFF native binary scrubbing (if a user drops an unsupported format like `.heic`, show a clear unsupported-format notice rather than failing silently).
- PDF visual redaction (blacking out visible text/images inside PDF pages — that's `#082`). TraceOff scrubs hidden document metadata only.
- Selective tag editing / spoofing (e.g., typing fake GPS coordinates). v1 focuses on clean, trustworthy removal.
- User accounts, cloud storage, or backend APIs.

### Anti-Goals (Failure Conditions Even If Code "Works")
- **Silent Privacy Leaks:** Making *any* outbound network request containing file names, file bytes, or extracted GPS coordinates (e.g., calling Google Maps / OpenStreetMap with leaked lat/lng) violates the core privacy promise.
- **Broken / Sideways Photos:** Stripping EXIF from a vertical smartphone JPEG (`Orientation: 6`) without normalizing orientation produces sideways images.
- **Silent Quality Degradation:** Re-encoding all JPEGs through `<canvas>` by default degrades photos and bloats file sizes.
- **Corrupted Output Files:** Truncated JPEG entropy data, invalid PNG chunk CRCs, or malformed WebP RIFF sizes.
- **Wrong Git Identity:** Committing or pushing under `st-arafat` instead of `tamzidpeace`.

---

## 3. Constraints

- **Location:** New project directory at `/Users/arafat/Documents/Products/traceoff`.
- **Git / GitHub Identity:**
  - Repo-local `git config user.name` and `git config user.email` must belong to `tamzidpeace` (confirmed with user before committing/pushing if `tamzidpeace`'s email or `gh` auth session needs switching).
  - Never push to `st-arafat`.
- **Runtime:** Modern evergreen browsers (Chrome, Firefox, Safari, Edge) with Web Workers, File/Blob APIs, and Canvas 2D support.
- **Dependencies:** Permissive open-source licenses only (MIT / Apache-2.0 / BSD).
- **Network Independence:** App must function completely offline once loaded/installed as a PWA (no external fonts CDN required at runtime; bundle UI assets locally).

---

## 4. Approaches Considered & Selected Approach

### Approaches Evaluated
1. **Canvas Re-Encoding (Images) + `pdf-lib` (PDFs):**
   - *Trade-off:* Simplest to implement, but lossy re-compression on every JPEG and strips ICC profiles indiscriminately.
2. **Lossless Binary Segment Stripping (Images) + `pdf-lib` (PDFs) in Web Workers** *(Selected)*:
   - *Trade-off:* Requires writing and testing dedicated binary walkers for JPEG, PNG, and WebP, plus handling JPEG EXIF Orientation `!= 1` cleanly. Delivers zero quality loss, millisecond speed on large files, tiny bundle size, and strong engineering depth.
3. **Full WASM Engine (`exiftool-wasm` / Rust-to-WASM):**
   - *Trade-off:* Broad format support, but multi-MB WASM payload, slower cold start, and unnecessary build complexity for JPEG/PNG/WebP/PDF.

### Selected Tech Stack (Builder Decision Made)
- **App Framework:** Vite + React 19 + TypeScript (strict mode)
- **Styling & Icons:** Tailwind CSS + `lucide-react` (clean dark/light privacy-tool aesthetic; no external Google Fonts dependency for strict offline privacy)
- **Metadata Inspection:**
  - Images: `exifr` (fast, modular parser for EXIF, GPS, XMP, IPTC, ICC detection)
  - PDFs: `pdf-lib` (reads Info dict, catalog/page `/Metadata` XMP streams, `/PieceInfo`, annotation `/Annots` authors/dates, and traverses image XObjects to inspect embedded `/DCTDecode` JPEG streams via `exifr` and any XObject `/Metadata` streams)
- **Scrubbing Engine (Pure TypeScript in Web Worker):**
  - **JPEG (`jpegScrubber.ts`):** Walks JPEG marker segments (`0xFF 0xXX`). Preserves `SOI`, `APP0 (JFIF)`, optional `APP2 (ICC_PROFILE)` based on user toggle, `APP14` (Adobe color transform marker if present to prevent CMYK/RGB color shift), quantization/Huffman/frame/scan tables, and entropy stream. Strips `APP1` (EXIF, XMP), `APP13` (IPTC/Photoshop), `COM` (comments), and other non-essential `APPn` metadata markers.
    - *Builder Call — Orientation vs. ICC Conflict:* When `Orientation` is `1` (or absent), scrubbing is **100% lossless** and preserves ICC if toggled ON. When a JPEG has `Orientation` `2..8` and `Auto-Fix Photo Orientation` is ON, `canvasFallback.ts` (`createImageBitmap` + `OffscreenCanvas`/Canvas) bakes upright pixels in **sRGB** (quality `0.95`), explicitly drops the wide-gamut ICC profile so colors never shift, and marks the output badge as `Oriented & Scrubbed (sRGB)` instead of `Lossless Scrubbed`. Turning `Auto-Fix Photo Orientation` OFF keeps it 100% lossless + ICC-preserved.
  - **PNG (`pngScrubber.ts`):** Validates 8-byte PNG signature and iterates chunks (`length + type + data + CRC32`). Keeps critical chunks (`IHDR`, `PLTE`, `IDAT`, `IEND`) and visual-rendering chunks (`tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP` if ICC toggle is kept). Strips metadata chunks (`eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`). Recomputes/validates CRC32 where needed (or copies intact chunks untouched).
  - **WebP (`webpScrubber.ts`):** Parses RIFF container (`RIFF` + size + `WEBP`), iterates subchunks, drops `EXIF` and `XMP ` (note trailing space in `'XMP '`), optionally drops `ICCP`, updates `VP8X` chunk feature flags (clearing EXIF bit `0x08`, XMP bit `0x04`, and ICC bit `0x20` if stripped — and if no `VP8X` extended features remain, keeps valid RIFF structure), and updates overall RIFF file size header.
  - **PDF (`pdfScrubber.ts` — Deep Object & Embedded-Image Scrubbing):** Uses `pdf-lib` (`PDFDocument.load` with `updateMetadata: false`) to:
    1. Clear document Info dictionary fields (`Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer`, `CreationDate`, `ModDate`) and prevent `pdf-lib` from writing its own default `Producer`.
    2. Delete catalog & page-level `/Metadata` (XMP streams) and `/PieceInfo`.
    3. Walk page `/Annots` (annotations/comments) to clear identifying fields (`/T` author, `/Subj`, `/CreationDate`, `/M` modification date) and any annotation `/Popup` or `/IRT` metadata.
    4. Recursively walk PDF indirect objects / XObjects (`/Subtype /Image`): delete any attached XObject `/Metadata` stream, and for `/Filter /DCTDecode` (JPEG) streams run `jpegScrubber` directly on the compressed stream bytes (preserving pixel quality while stripping embedded camera EXIF/GPS/XMP and updating `/Length`).
    5. Handle protected edge cases explicitly: encrypted/password-protected PDFs report a clear error; digitally signed PDFs (`/AcroForm` `/Sig` or `/ByteRange`) display an explicit warning that scrubbing alters bytes and invalidates cryptographic signatures.
- **Batch ZIP:** `fflate` (ultra-small, fast ZIP writer inside worker/client)
- **PWA & Base Path:** `vite-plugin-pwa` (offline precache of all JS/CSS/icons) with `base` parameterized via `VITE_BASE_PATH` (defaulting to `/traceoff/` for GitHub Pages builds and `/` for Vercel/local root deploys); all static asset paths (`public/samples/`) use `import.meta.env.BASE_URL`.
- **Testing:** `vitest` (unit tests constructing real/minimal binary JPEG, PNG, WebP, and PDF fixtures with embedded GPS/EXIF/XMP/Author tags, running inspect → scrub → re-inspect, and asserting 0 metadata + valid image/PDF headers + byte-exact `IDAT`/scan preservation for lossless paths).

---

## 5. User Experience & Core Flows

1. **Zero-Friction Landing & Dropzone**
   - Immediate single-screen workspace (no marketing bloat, no login wall).
   - Clear privacy guarantee banner: *"100% Local Processing — Files never leave your browser"* + offline status indicator.
   - Drag-and-drop zone + File Picker button + Paste-image support (`Ctrl/Cmd + V`).
   - Quick "Try with Sample Photo" button (bundles a tiny local demo JPEG with fake GPS/camera EXIF in `public/samples/` so YouTube viewers or first-time visitors can test immediately without digging for a photo).

2. **Queue & Privacy Risk Summary**
   - Files appear as cards/rows in a clean list as soon as dropped.
   - Each card shows:
     - Thumbnail preview (images) or PDF badge, filename, original size.
     - **Risk Level Badge:** e.g., `High Risk (GPS + Device)` (red), `Metadata Found` (amber), `Already Clean` (green).
     - Expandable **Metadata Inspector Drawer/Panel**:
       - Categorized table of discovered fields (Location: Lat/Lng/Altitude; Device: Make/Model/Lens/Serial; File/Author: Software/Creator/Author/Producer; Timestamps: DateTimeOriginal/CreateDate/ModifyDate; Other/Raw XMP/IPTC count).
       - **Important privacy detail:** Do *not* embed an external map widget for GPS coordinates (which would leak coordinates to map tile servers). Display raw coordinates + a local privacy warning badge instead.

3. **Scrubbing & Post-Scrub Verification**
   - **Options bar (minimal):**
     - `Preserve Color Profile (ICC)` toggle (default: **ON** — keeps accurate colors while stripping identifying metadata).
     - `Auto-Fix Photo Orientation` toggle (default: **ON** — prevents rotated phone photos from saving sideways).
     - Filename suffix option or clean default (`photo_clean.jpg` / keep original name inside ZIP).
   - **Action:** Primary **"Scrub All Files"** button (or auto-scrub toggle / per-file scrub button).
   - **After Scrub:**
     - Automatic **Re-Verification Check**: runs the inspector again on the scrubbed output bytes and displays `Verified Clean: 0 tracking tags remaining`, plus mode & size saved (e.g., `4.21 MB → 4.16 MB • Lossless` or `Oriented & Scrubbed (sRGB)` when Canvas orientation-baking ran).
     - Side-by-side **Before vs. After** metadata diff toggle on any file card so users visually see every leaked tag wiped out.

4. **Download & Reset**
   - Per-file **Download Clean File** button.
   - Batch **Download All (.zip)** button when 2+ files are scrubbed.
   - **Clear All** button that revokes all object URLs (`URL.revokeObjectURL`) to free memory immediately.

---

## 6. Architecture & Directory Structure

```text
traceoff/
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-11-26-traceoff-design.md
├── public/
│   ├── icons/                      # PWA icons
│   └── samples/                    # Local sample JPEG with safe synthetic EXIF/GPS
├── src/
│   ├── core/
│   │   ├── types.ts                # FileItem, MetadataReport, ScrubOptions, ScrubResult
│   │   ├── detectFormat.ts         # Magic-byte detection (JPEG, PNG, WebP, PDF)
│   │   ├── inspector/
│   │   │   ├── inspectImage.ts     # exifr wrapper -> normalized MetadataReport
│   │   │   └── inspectPdf.ts       # pdf-lib Info + XMP inspector -> MetadataReport
│   │   ├── scrubbers/
│   │   │   ├── jpegScrubber.ts     # Lossless JPEG segment walker + orientation check
│   │   │   ├── pngScrubber.ts      # Lossless PNG chunk walker
│   │   │   ├── webpScrubber.ts     # Lossless WebP RIFF chunk walker
│   │   │   ├── pdfScrubber.ts      # pdf-lib Info + catalog /Metadata stripper
│   │   │   └── canvasFallback.ts   # Orientation-baking Canvas re-encoder (main/OffscreenCanvas)
│   │   ├── scrubFile.ts            # Unified orchestrator (detect -> inspect -> scrub -> verify)
│   │   └── zipExport.ts            # fflate batch ZIP builder
│   ├── workers/
│   │   └── scrub.worker.ts         # Web Worker entry for non-blocking inspection & scrubbing
│   ├── components/
│   │   ├── Header.tsx              # Brand, privacy badge, offline indicator, theme toggle
│   │   ├── DropZone.tsx            # Drag/drop, file picker, clipboard paste, sample file loader
│   │   ├── OptionsBar.tsx          # ICC toggle, orientation toggle, batch actions
│   │   ├── FileCard.tsx            # Status, risk badge, size diff, download button
│   │   ├── MetadataDrawer.tsx      # Before/After categorized metadata inspector
│   │   └── Footer.tsx              # Open-source links & 100% local explanation
│   ├── hooks/
│   │   └── useScrubQueue.ts        # Queue state, worker bridge, ObjectURL cleanup
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── tests/
│   ├── fixtures/                   # Synthetic test binaries (JPEG+GPS, PNG+eXIf/tEXt, WebP+EXIF, PDF+XMP)
│   ├── jpegScrubber.test.ts
│   ├── pngScrubber.test.ts
│   ├── webpScrubber.test.ts
│   ├── pdfScrubber.test.ts
│   └── scrubFile.test.ts
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Typecheck + Vitest + Vite build
│       └── deploy.yml              # GitHub Pages build (VITE_BASE_PATH=/traceoff/) & deploy
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── LICENSE                         # MIT
└── README.md
```

---

## 7. What's Left to the Builder

The builder (implementation plan + execution) has freedom to settle:
- Exact Tailwind CSS color palette, typography, spacing, and dark/light theme tokens.
- Web Worker messaging protocol and concurrency limit (e.g., 2–4 concurrent workers or sequential worker queue).
- Exact UI layout of the `MetadataDrawer` (modal vs. inline expandable accordion).
- Exact synthetic fixture generation helper for unit tests so tests don't rely on large committed binary photos.
- GitHub Actions workflow setup for CI (and optional GitHub Pages deployment) once `tamzidpeace` remote is verified.
