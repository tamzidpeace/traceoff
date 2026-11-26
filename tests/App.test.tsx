import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { PdfInspectError } from '../src/core/inspector/inspectPdf';
import { PdfScrubError } from '../src/core/scrubbers/pdfScrubber';
import type { MetadataReport, ScrubOptions, ScrubResult } from '../src/core/types';

const mockInspect = vi.fn<(bytes: Uint8Array) => Promise<MetadataReport>>();
const mockScrub = vi.fn<(bytes: Uint8Array, options: ScrubOptions) => Promise<ScrubResult>>();
const mockDispose = vi.fn<() => void>();

vi.mock('../src/core/workerClient', () => {
  return {
    ScrubWorkerClient: class {
      inspect = mockInspect;
      scrub = mockScrub;
      dispose = mockDispose;
    },
  };
});

function makeJpegReport(overrides: Partial<MetadataReport> = {}): MetadataReport {
  return {
    format: 'jpeg',
    riskLevel: 'high',
    hasGps: true,
    orientation: 1,
    hasIccProfile: true,
    isSignedPdf: false,
    embeddedImageWithMetaCount: 0,
    totalTags: 4,
    fields: [
      {
        key: 'GPSLatitude',
        label: 'GPS Latitude',
        value: '37.774900° N',
        category: 'location',
        sensitive: true,
      },
      {
        key: 'GPSLongitude',
        label: 'GPS Longitude',
        value: '122.419400° W',
        category: 'location',
        sensitive: true,
      },
      {
        key: 'Model',
        label: 'Camera Model',
        value: 'Pixel 9 Pro',
        category: 'device',
        sensitive: true,
      },
      {
        key: 'Software',
        label: 'Author / Software',
        value: 'Lightroom Mobile',
        category: 'author',
        sensitive: true,
      },
    ],
    ...overrides,
  };
}

function makeCleanReport(format: MetadataReport['format'] = 'jpeg'): MetadataReport {
  return {
    format,
    riskLevel: 'clean',
    hasGps: false,
    orientation: null,
    hasIccProfile: true,
    isSignedPdf: false,
    embeddedImageWithMetaCount: 0,
    totalTags: 0,
    fields: [],
  };
}

function createTestFile(name: string, type: string, content = 'binary-data'): File {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], name, { type });
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
  return file;
}

describe('TraceOff App UI', () => {
  let createdUrls: string[];
  let revokedUrls: string[];
  let urlCounter: number;

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    urlCounter = 0;

    mockInspect.mockReset();
    mockScrub.mockReset();
    mockDispose.mockReset();

    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => {
          const url = `blob:traceoff-test-${++urlCounter}`;
          createdUrls.push(url);
          return url;
        }),
        revokeObjectURL: vi.fn((url: string) => {
          revokedUrls.push(url);
        }),
      })
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected network fetch');
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders privacy banner, offline indicator, and DropZone with "Try with Sample Photo" button', async () => {
    const sampleReport = makeJpegReport();
    mockInspect.mockResolvedValueOnce(sampleReport);

    const sampleBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([sampleBytes], { type: 'image/jpeg' }),
      arrayBuffer: async () => sampleBytes.buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(screen.getByText(/100% Local Processing/i)).toBeInTheDocument();
    expect(screen.getByText(/Files never leave your browser/i)).toBeInTheDocument();

    const sampleButton = screen.getByRole('button', { name: /Try with Sample Photo/i });
    expect(sampleButton).toBeInTheDocument();

    fireEvent.click(sampleButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/samples\/sample-photo\.jpg$/));
      expect(screen.getByText('sample-photo.jpg')).toBeInTheDocument();
    });
  });

  it('displays risk badge + leaked counts on upload and opens Before/After Metadata Drawer without external fetch', async () => {
    const report = makeJpegReport();
    mockInspect.mockResolvedValueOnce(report);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    const file = createTestFile('vacation.jpg', 'image/jpeg', 'jpeg-bytes');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('vacation.jpg')).toBeInTheDocument();
      expect(screen.getByText(/High Risk/i)).toBeInTheDocument();
    });

    // Shows leaked category/count indicators locally
    expect(screen.getByText(/4 tracking tags/i)).toBeInTheDocument();
    expect(screen.getByText('GPS')).toBeInTheDocument();
    expect(screen.getByText('Camera/Device (1)')).toBeInTheDocument();
    expect(screen.getByText('Author/Software (1)')).toBeInTheDocument();

    // Open Inspect Metadata drawer
    const inspectBtn = screen.getByRole('button', { name: /Inspect Metadata/i });
    fireEvent.click(inspectBtn);

    expect(screen.getByText('37.774900° N')).toBeInTheDocument();
    expect(screen.getByText('Pixel 9 Pro')).toBeInTheDocument();
    expect(screen.getByText('Lightroom Mobile')).toBeInTheDocument();
    expect(screen.getByText(/never sent to map servers/i)).toBeInTheDocument();

    // Strictly zero outbound network calls during inspection or GPS display
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scrubs files, displays Verified Clean + honest Lossless / Oriented & Scrubbed (sRGB) badges, and enables single & ZIP downloads', async () => {
    const losslessReport = makeJpegReport({ orientation: 1 });
    const orientedReport = makeJpegReport({
      orientation: 6,
      totalTags: 3,
      fields: makeJpegReport().fields.slice(0, 3),
    });

    mockInspect
      .mockResolvedValueOnce(losslessReport)
      .mockResolvedValueOnce(orientedReport);

    mockScrub
      .mockResolvedValueOnce({
        format: 'jpeg',
        cleanBytes: new Uint8Array([1, 2, 3, 4]),
        mode: 'lossless',
        before: losslessReport,
        after: makeCleanReport('jpeg'),
        originalSize: 2048,
        cleanSize: 1536,
        warnings: [],
      })
      .mockResolvedValueOnce({
        format: 'jpeg',
        cleanBytes: new Uint8Array([5, 6, 7, 8]),
        mode: 'oriented-srgb',
        before: orientedReport,
        after: makeCleanReport('jpeg'),
        originalSize: 4096,
        cleanSize: 3200,
        warnings: [
          'ICC color profile was converted to sRGB while baking EXIF orientation into pixel order.',
        ],
      });

    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file1 = createTestFile('photo-one.jpg', 'image/jpeg', 'one');
    const file2 = createTestFile('photo-two.jpg', 'image/jpeg', 'two');
    fireEvent.change(input, { target: { files: [file1, file2] } });

    await waitFor(() => {
      expect(screen.getByText('photo-one.jpg')).toBeInTheDocument();
      expect(screen.getByText('photo-two.jpg')).toBeInTheDocument();
    });

    const scrubAllBtn = screen.getByRole('button', { name: /Scrub All Files/i });
    const zipBtn = screen.getByRole('button', { name: /Download All \(\.zip\)/i });
    expect(zipBtn).toBeDisabled();

    fireEvent.click(scrubAllBtn);

    await waitFor(() => {
      expect(screen.getAllByText('Verified Clean: 0 tracking tags remaining')).toHaveLength(2);
    });

    expect(screen.getByText('Lossless')).toBeInTheDocument();
    expect(screen.getByText('Oriented & Scrubbed (sRGB)')).toBeInTheDocument();
    expect(
      screen.getByText(/ICC color profile was converted to sRGB while baking EXIF orientation/i)
    ).toBeInTheDocument();

    const downloadLinks = screen.getAllByRole('link', { name: /Download Clean File/i });
    expect(downloadLinks).toHaveLength(2);
    expect(downloadLinks[0]).toHaveAttribute('download', 'photo-one_clean.jpg');
    expect(downloadLinks[1]).toHaveAttribute('download', 'photo-two_clean.jpg');

    expect(zipBtn).toBeEnabled();

    // Test Download All (.zip) triggers anchor download and revokes temporary ObjectURL
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const urlsBeforeZip = createdUrls.length;
    fireEvent.click(zipBtn);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(createdUrls.length).toBe(urlsBeforeZip + 1);
    const zipObjectUrl = createdUrls[createdUrls.length - 1]!;
    expect(revokedUrls).toContain(zipObjectUrl);

    // Inspect Metadata after scrubbing shows Before vs After Removed pills
    const cardOne = screen.getByTestId('file-card-photo-one.jpg');
    fireEvent.click(within(cardOne).getByRole('button', { name: /Inspect Metadata/i }));
    expect(within(cardOne).getByText(/Before vs\. After Metadata Inspection/i)).toBeInTheDocument();
    expect(within(cardOne).getAllByText('Removed')).toHaveLength(4);
  });

  it('requires explicit confirmation before scrubbing a digitally signed PDF', async () => {
    const signedPdfReport: MetadataReport = {
      format: 'pdf',
      riskLevel: 'medium',
      hasGps: false,
      orientation: null,
      hasIccProfile: false,
      isSignedPdf: true,
      embeddedImageWithMetaCount: 0,
      totalTags: 2,
      fields: [
        {
          key: 'Author',
          label: 'Author',
          value: 'Alice',
          category: 'author',
          sensitive: true,
        },
        {
          key: 'Producer',
          label: 'PDF Producer',
          value: 'Acrobat',
          category: 'author',
          sensitive: false,
        },
      ],
    };

    mockInspect.mockResolvedValueOnce(signedPdfReport);
    mockScrub.mockImplementation(async (_bytes, options) => {
      if (!options.allowSignedPdfScrub) {
        throw new PdfScrubError(
          'signed-confirmation-required',
          'Signed PDF confirmation is required'
        );
      }
      return {
        format: 'pdf',
        cleanBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        mode: 'pdf-deep',
        before: signedPdfReport,
        after: makeCleanReport('pdf'),
        originalSize: 5000,
        cleanSize: 4200,
        warnings: ['Digital signature fields were removed/invalidated during scrubbing.'],
      };
    });

    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const pdfFile = createTestFile('contract.pdf', 'application/pdf', '%PDF-1.7');
    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByText('contract.pdf')).toBeInTheDocument();
      expect(screen.getByText(/Digitally signed PDF/i)).toBeInTheDocument();
    });

    // Clicking Scrub All without confirming does NOT pass allowSignedPdfScrub: true
    fireEvent.click(screen.getByRole('button', { name: /Scrub All Files/i }));
    expect(mockScrub).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowSignedPdfScrub: true })
    );

    // Explicit confirmation button scrubs with allowSignedPdfScrub: true
    const confirmBtn = screen.getByRole('button', { name: /Confirm & Scrub Signed PDF/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockScrub).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.objectContaining({ allowSignedPdfScrub: true })
      );
      expect(screen.getByText('Verified Clean: 0 tracking tags remaining')).toBeInTheDocument();
      expect(screen.getByText('Deep PDF Scrubbed')).toBeInTheDocument();
    });
  });

  it('removes all items and calls URL.revokeObjectURL on "Clear All" and unmount', async () => {
    const report = makeJpegReport();
    mockInspect.mockResolvedValueOnce(report);
    mockScrub.mockResolvedValueOnce({
      format: 'jpeg',
      cleanBytes: new Uint8Array([1, 2, 3]),
      mode: 'lossless',
      before: report,
      after: makeCleanReport('jpeg'),
      originalSize: 1000,
      cleanSize: 800,
      warnings: [],
    });

    const { container, unmount } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = createTestFile('clear-me.jpg', 'image/jpeg', 'bytes');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('clear-me.jpg')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Scrub All Files/i }));

    await waitFor(() => {
      expect(screen.getByText('Verified Clean: 0 tracking tags remaining')).toBeInTheDocument();
    });

    // Created previewUrl + cleanUrl
    expect(createdUrls.length).toBeGreaterThanOrEqual(2);

    const clearBtn = screen.getByRole('button', { name: /Clear All/i });
    fireEvent.click(clearBtn);

    expect(screen.queryByText('clear-me.jpg')).not.toBeInTheDocument();
    for (const url of createdUrls) {
      expect(revokedUrls).toContain(url);
    }

    unmount();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('toggles theme and passes updated ScrubOptions when options change', async () => {
    const report = makeJpegReport({ orientation: 6 });
    mockInspect.mockResolvedValueOnce(report);
    mockScrub.mockResolvedValueOnce({
      format: 'jpeg',
      cleanBytes: new Uint8Array([1, 2, 3]),
      mode: 'lossless',
      before: report,
      after: makeCleanReport('jpeg'),
      originalSize: 1000,
      cleanSize: 900,
      warnings: [],
    });

    const { container } = render(<App />);

    // Dark mode default, toggle to light
    const themeToggle = screen.getByRole('button', { name: /Switch to light mode/i });
    fireEvent.click(themeToggle);
    expect(screen.getByRole('button', { name: /Switch to dark mode/i })).toBeInTheDocument();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [createTestFile('portrait.jpg', 'image/jpeg', 'jpg')] },
    });

    await waitFor(() => {
      expect(screen.getByText('portrait.jpg')).toBeInTheDocument();
    });

    const iccCheckbox = screen.getByLabelText(/Preserve Color Profile \(ICC\)/i);
    const orientCheckbox = screen.getByLabelText(/Auto-Fix Photo Orientation/i);
    fireEvent.click(iccCheckbox);
    fireEvent.click(orientCheckbox);

    const card = screen.getByTestId('file-card-portrait.jpg');
    fireEvent.click(within(card).getByRole('button', { name: /^Scrub$/i }));

    await waitFor(() => {
      expect(mockScrub).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.objectContaining({
          preserveIcc: false,
          autoFixOrientation: false,
        })
      );
    });
  });

  it('revokes ObjectURLs when removing a single file and displays encrypted PDF / already-clean states', async () => {
    const cleanReport = makeCleanReport('png');
    mockInspect
      .mockResolvedValueOnce(cleanReport)
      .mockRejectedValueOnce(
        new PdfInspectError('encrypted', 'Encrypted PDFs cannot be scrubbed without decrypting first.')
      );

    mockScrub.mockResolvedValueOnce({
      format: 'png',
      cleanBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mode: 'already-clean',
      before: cleanReport,
      after: cleanReport,
      originalSize: 512,
      cleanSize: 512,
      warnings: [],
    });

    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: {
        files: [
          createTestFile('clean.png', 'image/png', 'png'),
          createTestFile('locked.pdf', 'application/pdf', '%PDF-locked'),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('clean.png')).toBeInTheDocument();
      expect(screen.getByText('locked.pdf')).toBeInTheDocument();
      expect(screen.getByText(/Encrypted PDFs cannot be scrubbed/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Scrub All Files/i }));

    await waitFor(() => {
      expect(screen.getByText('Verified Clean: 0 tracking tags remaining')).toBeInTheDocument();
      const card = screen.getByTestId('file-card-clean.png');
      expect(within(card).getAllByText('Already Clean').length).toBeGreaterThanOrEqual(1);
    });

    // Remove clean.png -> its previewUrl & cleanUrl are revoked
    const createdForClean = [...createdUrls];
    fireEvent.click(screen.getByRole('button', { name: 'Remove clean.png' }));
    expect(screen.queryByText('clean.png')).not.toBeInTheDocument();
    for (const url of createdForClean) {
      expect(revokedUrls).toContain(url);
    }
  });

  it('does not leak an unrevoked cleanUrl ObjectURL when removing or clearing a file while scrub is pending', async () => {
    const reportOne = makeJpegReport();
    const reportTwo = makeJpegReport();
    mockInspect.mockResolvedValueOnce(reportOne).mockResolvedValueOnce(reportTwo);

    let resolveScrubOne!: (result: ScrubResult) => void;
    let resolveScrubTwo!: (result: ScrubResult) => void;
    mockScrub
      .mockImplementationOnce(
        () =>
          new Promise<ScrubResult>((resolve) => {
            resolveScrubOne = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<ScrubResult>((resolve) => {
            resolveScrubTwo = resolve;
          })
      );

    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          createTestFile('pending-remove.jpg', 'image/jpeg', 'one'),
          createTestFile('pending-clear.jpg', 'image/jpeg', 'two'),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('pending-remove.jpg')).toBeInTheDocument();
      expect(screen.getByText('pending-clear.jpg')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Scrub All Files/i }));

    await waitFor(() => {
      expect(screen.getAllByText('Scrubbing locally...')).toHaveLength(2);
    });

    const urlsCreatedBeforeRemoval = createdUrls.length;
    expect(urlsCreatedBeforeRemoval).toBe(2);

    // Remove the first file while its scrub is still pending
    fireEvent.click(screen.getByRole('button', { name: 'Remove pending-remove.jpg' }));
    expect(screen.queryByText('pending-remove.jpg')).not.toBeInTheDocument();

    // Clear the remaining file while its scrub is still pending
    fireEvent.click(screen.getByRole('button', { name: /Clear All/i }));
    expect(screen.queryByText('pending-clear.jpg')).not.toBeInTheDocument();

    // Now both pending scrubs resolve
    resolveScrubOne({
      format: 'jpeg',
      cleanBytes: new Uint8Array([1, 2, 3]),
      mode: 'lossless',
      before: reportOne,
      after: makeCleanReport('jpeg'),
      originalSize: 1000,
      cleanSize: 800,
      warnings: [],
    });
    resolveScrubTwo({
      format: 'jpeg',
      cleanBytes: new Uint8Array([4, 5, 6]),
      mode: 'lossless',
      before: reportTwo,
      after: makeCleanReport('jpeg'),
      originalSize: 1000,
      cleanSize: 800,
      warnings: [],
    });

    await waitFor(() => {
      expect(mockScrub).toHaveBeenCalledTimes(2);
    });
    // Flush any remaining microtasks from the resolved scrub promises
    await Promise.resolve();
    await Promise.resolve();

    // No cleanUrl ObjectURL was created after removal/clear, and every created URL was revoked
    expect(createdUrls).toHaveLength(urlsCreatedBeforeRemoval);
    for (const url of createdUrls) {
      expect(revokedUrls).toContain(url);
    }
    expect(new Set(revokedUrls)).toEqual(new Set(createdUrls));
  });

  it('disables "Confirm & Scrub Signed PDF" while scrubbing and prevents concurrent scrub calls', async () => {
    const signedPdfReport: MetadataReport = {
      format: 'pdf',
      riskLevel: 'medium',
      hasGps: false,
      orientation: null,
      hasIccProfile: false,
      isSignedPdf: true,
      embeddedImageWithMetaCount: 0,
      totalTags: 1,
      fields: [
        {
          key: 'Author',
          label: 'Author',
          value: 'Bob',
          category: 'author',
          sensitive: true,
        },
      ],
    };

    let resolveSignedScrub!: (result: ScrubResult) => void;
    mockInspect.mockResolvedValueOnce(signedPdfReport);
    mockScrub.mockImplementationOnce(
      () =>
        new Promise<ScrubResult>((resolve) => {
          resolveSignedScrub = resolve;
        })
    );

    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [createTestFile('signed-inflight.pdf', 'application/pdf', '%PDF-1.7')] },
    });

    await waitFor(() => {
      expect(screen.getByText('signed-inflight.pdf')).toBeInTheDocument();
      expect(screen.getByText(/Digitally signed PDF/i)).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole('button', { name: /Confirm & Scrub Signed PDF/i });
    const confirmCheckbox = screen.getByRole('checkbox', {
      name: /I understand scrubbing will invalidate the digital signature/i,
    });
    expect(confirmBtn).toBeEnabled();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText('Scrubbing locally...')).toBeInTheDocument();
    });

    expect(confirmBtn).toBeDisabled();
    expect(confirmCheckbox).toBeDisabled();
    expect(mockScrub).toHaveBeenCalledTimes(1);

    // Attempting to click again while scrubbing must not trigger a concurrent scrub call
    fireEvent.click(confirmBtn);
    expect(mockScrub).toHaveBeenCalledTimes(1);

    resolveSignedScrub({
      format: 'pdf',
      cleanBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mode: 'pdf-deep',
      before: signedPdfReport,
      after: makeCleanReport('pdf'),
      originalSize: 2000,
      cleanSize: 1600,
      warnings: ['Digital signature fields were removed/invalidated during scrubbing.'],
    });

    await waitFor(() => {
      expect(screen.getByText('Verified Clean: 0 tracking tags remaining')).toBeInTheDocument();
    });
    expect(mockScrub).toHaveBeenCalledTimes(1);
  });
});
