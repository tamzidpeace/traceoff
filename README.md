# TraceOff

**100% client-side, offline-ready metadata inspector and scrubber for JPEG, PNG, WebP, and PDF files.**

- **Live Demo:** https://tamzidpeace.github.io/traceoff/
- **Repository:** https://github.com/tamzidpeace/traceoff

TraceOff inspects and removes hidden privacy-sensitive metadata—GPS coordinates, camera/device identifiers, author names, timestamps, XMP packets, and embedded PDF image metadata—directly inside your browser using a dedicated Web Worker.

---

## Privacy Architecture

```text
User File (JPEG / PNG / WebP / PDF)
   │
   ▼
Magic-Byte Format Detection (JPEG / PNG / WebP / PDF)
   │
   ▼
Web Worker Pipeline (100% Local Memory, Zero Network Requests)
   ├── 1. Inspect Before-State  ──► Risk Level (High / Medium / Clean) + Field Breakdown
   ├── 2. Scrub Metadata        ──► Lossless Binary Stream/Chunk Stripper or Deep PDF Scrubber
   └── 3. Re-Inspect After-State──► Verified Clean MetadataReport & Byte Diff
   │
   ▼
Single File Download or Collision-Safe Batch ZIP Export (fflate)
```

- **Zero uploads:** Files are read into `Uint8Array` buffers in browser memory and never leave your device.
- **Zero telemetry:** No analytics, tracking scripts, or external API calls.
- **Offline-ready PWA:** Precached app shell via `vite-plugin-pwa` with live online/offline status in the header.
- **Magic-byte detection:** Validates file headers (`detectFormat`) rather than trusting file extensions.
- **Before/After verification:** Every scrubbed output is automatically re-inspected so you can verify `0` metadata tags remain before downloading.

---

## Supported Formats & Scrubbing Modes

| Format | What Is Inspected | How TraceOff Scrubs It |
| --- | --- | --- |
| **JPEG** | EXIF, GPS, XMP, IPTC/Photoshop, ICC profile, orientation | **Lossless** by default: strips metadata marker segments (`APP1`, `APP13`, `COM`, and optionally `APP2` ICC) while keeping quantization/Huffman tables and scan data untouched. |
| **PNG** | `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`, `iCCP` | **Lossless**: removes metadata chunks while keeping `IHDR`, `IDAT`, `IEND`, and rendering chunks byte-identical. |
| **WebP** | RIFF `EXIF`, `XMP `, `ICCP`, `VP8X` flags | **Lossless**: strips metadata chunks, preserves RIFF even-byte padding rules, clears corresponding `VP8X` flags, and updates the outer RIFF chunk size. |
| **PDF (Deep)** | `Info` dict, XMP `/Metadata`, page/Form XObject metadata & `PieceInfo`, annotation authors/dates, embedded JPEG XObjects, digital signatures | **Deep PDF scrub**: clears `Info` & catalog XMP, strips page/Form XObject `Metadata` & `PieceInfo`, scrubs annotation `/T`, `/Subj`, `/CreationDate`, `/M`, and recursively scrubs embedded `/DCTDecode` JPEG XObject streams. Encrypted PDFs are rejected safely; digitally signed PDFs require explicit opt-in confirmation. |

### Lossless vs. sRGB Orientation-Baking Behavior

- **Lossless (`lossless`):** The default for PNG, WebP, and upright JPEGs (or JPEGs when **Auto-fix orientation** is turned off). Pixel data is never re-encoded, and ICC color profiles can be preserved (`preserveIcc: true`).
- **Orientation-baked (`oriented-srgb`):** When a JPEG has EXIF orientation `2`–`8` and **Auto-fix orientation** is enabled, stripping the EXIF orientation tag alone would leave the image rotated sideways in browsers/viewers. TraceOff decodes and bakes the correct pixel orientation via HTML5 Canvas (`oriented-srgb`). Because Canvas normalizes output to **sRGB**, any wide-gamut ICC profile (such as Display P3) is converted to sRGB and TraceOff surfaces a clear warning.

---

## Tech Stack

- **UI & Framework:** React 19, TypeScript, Tailwind CSS v4, Lucide icons
- **Build & PWA:** Vite 6, `vite-plugin-pwa`
- **Metadata & Binary Processing:**
  - `exifr` for image metadata inspection
  - Custom lossless binary scrubbers for JPEG, PNG, and WebP
  - `pdf-lib` for deep PDF structure, annotation, and embedded XObject scrubbing
  - `fflate` for collision-safe client-side ZIP bundling
- **Testing:** Vitest, Testing Library (`@testing-library/react`, `@testing-library/jest-dom`), `jsdom`

---

## Local Development & Testing

### Prerequisites

- Node.js 20+ (CI runs on Node 22)
- npm

### Commands

```bash
# Install dependencies
npm install

# Start the local Vite dev server
npm run dev

# Run the Vitest test suite
npm test

# Run TypeScript typechecking
npm run typecheck

# Build for production (root base path '/')
npm run build
```

You can also click **Try with Sample Photo** in the app to test metadata inspection and scrubbing immediately with the bundled sample JPEG (`public/samples/sample-photo.jpg`).

---

## Deployment

TraceOff supports configurable `base` paths via `VITE_BASE_PATH` (defaulting to `/`) in `vite.config.ts`, updating both Vite asset URLs and the PWA web manifest `start_url`/`scope`.

### GitHub Pages (`/traceoff/`)

This repository includes `.github/workflows/deploy.yml`, which automatically builds with `VITE_BASE_PATH=/traceoff/` and deploys `dist/` to GitHub Pages on every push to `main` (or via manual `workflow_dispatch`).

To build the GitHub Pages bundle locally:

```bash
VITE_BASE_PATH=/traceoff/ npm run build
```

In your GitHub repository settings under **Settings → Pages**, set **Source** to **GitHub Actions**.

### Vercel / Cloudflare Pages / Netlify (`/`)

Deploy the static `dist/` directory using the default root base path:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Environment variables:** none required (`VITE_BASE_PATH` defaults to `/`)

---

## License

MIT © 2026 [tamzidpeace](LICENSE)
