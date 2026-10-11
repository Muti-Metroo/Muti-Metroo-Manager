import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FilesTab from '../FilesTab';
import type { FileBrowseEntry, TopologyAgentInfo } from '../../../api/types';

const { browseFilesMock, uploadFileMock } = vi.hoisted(() => ({
  browseFilesMock: vi.fn(),
  uploadFileMock: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  browseFiles: browseFilesMock,
  uploadFile: uploadFileMock,
  downloadFile: vi.fn(),
  chmodFile: vi.fn(),
  deleteFile: vi.fn(),
}));

const agent = {
  id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  short_id: 'a1b2',
} as TopologyAgentInfo;

function makeEntries(count: number): FileBrowseEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file-${String(i).padStart(4, '0')}`,
    size: 10,
    mode: '0644',
    mod_time: '2026-01-01T00:00:00Z',
    is_dir: false,
  }));
}

function mockListing(entries: FileBrowseEntry[]) {
  browseFilesMock.mockImplementation((_id: string, action: string) => {
    if (action === 'roots') return Promise.resolve({ roots: ['/'], wildcard: false });
    return Promise.resolve({ path: '/', entries, total: entries.length, truncated: false });
  });
}

describe('FilesTab render cap', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('caps rendered rows at 500 and reveals more via Show more', async () => {
    mockListing(makeEntries(600));
    render(<FilesTab agent={agent} disabled={false} onDisabled={() => {}} />);

    // First render page is present, entries past the cap are not.
    expect(await screen.findByText('file-0000')).toBeInTheDocument();
    expect(screen.getByText('file-0499')).toBeInTheDocument();
    expect(screen.queryByText('file-0500')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show more \(100 hidden\)/ }));
    expect(screen.getByText('file-0500')).toBeInTheDocument();
    expect(screen.getByText('file-0599')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('renders all rows without a Show more button below the cap', async () => {
    mockListing(makeEntries(3));
    render(<FilesTab agent={agent} disabled={false} onDisabled={() => {}} />);

    expect(await screen.findByText('file-0002')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });
});

describe('FilesTab upload cancel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('aborts the in-flight upload when Cancel is clicked', async () => {
    mockListing(makeEntries(1));
    let capturedSignal: AbortSignal | undefined;
    uploadFileMock.mockImplementation(
      (_id: string, _file: File, _path: string, _onProgress?: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Upload aborted', 'AbortError')),
          );
        });
      },
    );

    const { container } = render(<FilesTab agent={agent} disabled={false} onDisabled={() => {}} />);
    await screen.findByText('file-0000');

    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['x'], 'up.txt')] } });

    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    expect(capturedSignal?.aborted).toBe(false);

    fireEvent.click(cancelButton);
    expect(capturedSignal?.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.getByText(/Uploaded 0 of 1/)).toBeInTheDocument();
    });
  });
});
