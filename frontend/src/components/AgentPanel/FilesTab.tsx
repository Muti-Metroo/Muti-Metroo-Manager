import { useState, useEffect, useCallback, useRef } from 'react';
import type { TopologyAgentInfo, FileBrowseEntry } from '../../api/types';
import { isWindowsAgent } from '../../api/types';
import { browseFiles, downloadFile, uploadFile, chmodFile, deleteFile } from '../../api/client';
import { downloadBlob } from '../../util/download';
import { isFileTransferDenied, mapManagementAuthError } from '../../util/authErrors';
import { useModalDismiss } from '../../hooks/useModalDismiss';
import { agentLabel } from '../../util/useTopologyDiff';
import Alert from '../Alert';
import ConfirmDialog from '../ConfirmDialog';
import ShareFolderDialog from '../FileShares/ShareFolderDialog';

function parseErrFields(err: unknown): { code: unknown; message: string } {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      // Agent error shapes in the wild: {message}, {error}, {code, message},
      // {error, error_code}. Prefer the structured code; pick the most specific
      // human-readable field for the message, falling back to the raw body.
      return {
        code: obj.code ?? obj.error_code,
        message: obj.message ?? obj.error ?? raw,
      };
    }
  } catch {
    /* plain-text error */
  }
  return { code: undefined, message: raw };
}

const VIEW_MAX_SIZE = 1024 * 1024; // 1MB

// Cap on DOM rows rendered for a directory listing. The fetch side already
// stops at MAX_PAGES × PAGE_SIZE entries, but that only bounds memory — a
// 100k-entry directory would still hang the tab if every row mounted.
// "Show more" raises the limit in pages.
const RENDER_PAGE = 500;

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
]);

function isImageFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function isPdfFile(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

function isPreviewable(name: string): boolean {
  return isImageFile(name) || isPdfFile(name);
}

interface FilesTabProps {
  agent: TopologyAgentInfo;
  disabled: boolean;
  onDisabled: () => void;
}

function isBinaryContent(buf: Uint8Array): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b <= 0x08 || (b >= 0x0e && b <= 0x1f)) return true;
  }
  return false;
}

const HEX_DUMP_MAX = 1024 * 1024; // 1MB cap for hex dump input

function formatHexDump(buf: Uint8Array): { text: string; truncated: boolean } {
  const truncated = buf.length > HEX_DUMP_MAX;
  const view = truncated ? buf.subarray(0, HEX_DUMP_MAX) : buf;
  const lines: string[] = [];
  for (let off = 0; off < view.length; off += 16) {
    const chunk = view.subarray(off, Math.min(off + 16, view.length));
    const offset = off.toString(16).padStart(8, '0');
    let hex1 = '';
    let hex2 = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const h = chunk[i].toString(16).padStart(2, '0');
        if (i < 8) hex1 += h + ' ';
        else hex2 += h + ' ';
        ascii += chunk[i] >= 0x20 && chunk[i] <= 0x7e ? String.fromCharCode(chunk[i]) : '.';
      } else {
        if (i < 8) hex1 += '   ';
        else hex2 += '   ';
        ascii += ' ';
      }
    }
    lines.push(`${offset}  ${hex1} ${hex2} |${ascii}|`);
  }
  return { text: lines.join('\n'), truncated };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Split an absolute path into segments for breadcrumb rendering */
/** Detect whether a path uses Windows-style separators */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\\/]/.test(path);
}

/** Expand a leading ~ or ~/ (and ~\ on Windows) using the agent's home dir.
 *  If home is unknown, pass through unchanged so the agent surfaces a clear error. */
function expandTilde(path: string, home: string | null): string {
  if (!home) return path;
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    const sep = isWindowsPath(home) ? '\\' : '/';
    const trimmedHome = home.replace(/[\\\/]+$/, '');
    return trimmedHome + sep + path.slice(2);
  }
  return path;
}

function pathSegments(path: string): { name: string; path: string }[] {
  if (isWindowsPath(path)) {
    const parts = path.split(/[\\\/]/).filter(Boolean);
    const segments: { name: string; path: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      segments.push({
        name: parts[i],
        path: i === 0 ? parts[0] + '\\' : parts.slice(0, i + 1).join('\\'),
      });
    }
    return segments;
  }
  const parts = path.split('/').filter(Boolean);
  const segments: { name: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    segments.push({ name: parts[i], path: '/' + parts.slice(0, i + 1).join('/') });
  }
  return segments;
}

/** Return an icon character for a file entry */
function entryIcon(entry: FileBrowseEntry): string {
  if (entry.is_symlink) return '\u{1F517}';
  if (entry.is_dir) return '\u{1F4C1}';
  return '\u{1F4C4}';
}

/** Recursively collect files from DataTransferItemList (supports folders via webkitGetAsEntry) */
async function collectDroppedFiles(
  items: DataTransferItemList,
): Promise<{ file: File; relativePath: string }[]> {
  const result: { file: File; relativePath: string }[] = [];

  function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  async function walk(entry: FileSystemEntry, prefix: string) {
    if (entry.isFile) {
      const file = await fileFromEntry(entry as FileSystemFileEntry);
      result.push({ file, relativePath: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const dirPrefix = prefix + entry.name + '/';
      // Chrome batches at 100 — loop until empty
      let batch: FileSystemEntry[];
      do {
        batch = await readEntries(reader);
        for (const child of batch) {
          await walk(child, dirPrefix);
        }
      } while (batch.length > 0);
    }
  }

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) {
      entries.push(entry);
    } else {
      // Fallback: no webkitGetAsEntry support
      const file = items[i].getAsFile();
      if (file) result.push({ file, relativePath: file.name });
    }
  }

  for (const entry of entries) {
    await walk(entry, '');
  }

  return result;
}

/** Join a directory path with a filename */
function joinPath(dir: string, name: string): string {
  if (isWindowsPath(dir)) {
    return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + '\\' + name;
  }
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/** Get parent directory path */
function parentPath(path: string): string | null {
  if (isWindowsPath(path)) {
    // Root like "C:\" has no parent
    if (/^[A-Za-z]:[\\\/]$/.test(path)) return null;
    const normalized = path.replace(/\//g, '\\');
    const idx = normalized.lastIndexOf('\\');
    if (idx <= 2) return path.substring(0, 3); // back to "C:\"
    return normalized.substring(0, idx);
  }
  if (path === '/') return null;
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.substring(0, idx);
}

/** Format mode string to 4-digit octal (e.g. "0755") */
function formatMode(mode: string): string {
  const n = parseInt(mode, 8);
  if (isNaN(n)) return mode;
  return toOctalString(n & 0o7777);
}

/** Format a permission bits number as "0xxx" octal string */
function toOctalString(n: number): string {
  return '0' + n.toString(8).padStart(3, '0');
}

/** Parse 4-digit octal mode string to permission bits number */
function parseOctalMode(s: string): number | null {
  if (!/^0?[0-7]{3,4}$/.test(s)) return null;
  const n = parseInt(s, 8);
  if (isNaN(n) || n < 0 || n > 0o7777) return null;
  return n;
}

/** Convert permission bits to rwx booleans: [owner, group, other] x [r, w, x] */
function modeToBits(mode: number): boolean[][] {
  return [
    [(mode & 0o400) !== 0, (mode & 0o200) !== 0, (mode & 0o100) !== 0],
    [(mode & 0o040) !== 0, (mode & 0o020) !== 0, (mode & 0o010) !== 0],
    [(mode & 0o004) !== 0, (mode & 0o002) !== 0, (mode & 0o001) !== 0],
  ];
}

/** Convert rwx booleans back to octal mode number (preserves setuid/setgid/sticky from original) */
function bitsToMode(bits: boolean[][], original: number): number {
  let m = original & 0o7000; // preserve special bits
  for (let group = 0; group < 3; group++) {
    for (let perm = 0; perm < 3; perm++) {
      if (bits[group][perm]) m |= 1 << (8 - group * 3 - perm);
    }
  }
  return m;
}

interface UploadProgress {
  totalFiles: number;
  doneFiles: number;
  failed: number;
  totalBytes: number;
  uploadedBytes: number;
  currentName: string;
}

// Directory-listing row. Shared by the real entries and the ".." row.
const FILE_ROW =
  'border-base-content/5 hover:bg-base-200 flex items-center gap-2 border-b px-2 py-1 last:border-b-0';

interface UploadProgressBarProps {
  progress: UploadProgress;
  onCancel: () => void;
}

function UploadProgressBar({ progress, onCancel }: UploadProgressBarProps) {
  const pct =
    progress.totalBytes > 0 ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100) : 0;

  return (
    <div className="space-y-1">
      <div
        className="bg-base-300 h-1 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="bg-primary h-full transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-muted flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">
          {progress.doneFiles}/{progress.totalFiles}
          {progress.failed > 0 && <span className="text-error"> ({progress.failed} failed)</span>}
          {' \u2014 '}
          {progress.currentName}
        </span>
        <span className="shrink-0 font-mono">
          {pct}% {formatSize(progress.uploadedBytes)}/{formatSize(progress.totalBytes)}
        </span>
        <button type="button" className="btn btn-xs btn-text shrink-0" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function FilesTab({ agent, disabled, onDisabled }: FilesTabProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // "Share this folder" dialog, for the directory currently listed.
  const [sharingPath, setSharingPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileBrowseEntry[]>([]);
  const [roots, setRoots] = useState<string[] | null>(null);
  const [wildcard, setWildcard] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null,
  );
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{
    path: string;
    name: string;
    size: number;
  } | null>(null);
  const [viewContent, setViewContent] = useState<{
    type: 'text' | 'binary';
    text: string;
    truncated?: boolean;
  } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewImageUrl, setViewImageUrl] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'preview' | 'hex'>('preview');
  // Context menu state
  const [menuOpenPath, setMenuOpenPath] = useState<string | null>(null);
  // Chmod dialog state
  const [chmodTarget, setChmodTarget] = useState<{
    path: string;
    name: string;
    mode: string;
  } | null>(null);
  const [chmodValue, setChmodValue] = useState('');
  const [chmodSaving, setChmodSaving] = useState(false);
  const [chmodError, setChmodError] = useState<string | null>(null);
  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);
  const [deleteDeleting, setDeleteDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ file: File; remotePath: string }[] | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  // Path editor (lets the user jump directly to a path when breadcrumb
  // navigation is blocked — e.g. home is at /homes/user but / is unreadable)
  const [pathEditing, setPathEditing] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [rootsPathInput, setRootsPathInput] = useState('');
  const dragCounter = useRef(0);
  const uploadCancelledRef = useRef(false);
  // Aborts the in-flight XHR of the currently-uploading file; set by the
  // upload-queue effect, invoked by the Cancel button.
  const uploadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Flag the panel that a file dialog/menu is open so its own Escape handler
  // doesn't close the whole panel; the listeners below still close the dialog.
  useModalDismiss({
    open: !!(viewingFile || menuOpenPath || chmodTarget || deleteTarget || pathEditing),
  });
  const onDisabledRef = useRef(onDisabled);
  onDisabledRef.current = onDisabled;

  const [truncated, setTruncated] = useState<{ shown: number; total: number } | null>(null);
  // How many listing rows are actually rendered (see RENDER_PAGE). Reset
  // whenever a new listing loads.
  const [renderLimit, setRenderLimit] = useState(RENDER_PAGE);

  const mapAuthErrorMessage = useCallback((err: unknown): string | null => {
    const { code, message } = parseErrFields(err);
    if (isFileTransferDenied(code, message)) {
      onDisabledRef.current();
      return null;
    }
    return mapManagementAuthError(code, message);
  }, []);

  const [refreshKey, setRefreshKey] = useState(0);

  const doRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  // Load roots on mount + whenever the refresh key bumps.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await browseFiles(agent.id, 'roots');
        if (cancelled) return;
        if (resp.error) {
          setError(mapAuthErrorMessage(resp.error) ?? resp.error);
          setLoading(false);
          return;
        }
        setWildcard(resp.wildcard);
        setHome(resp.home ?? null);
        // The wildcard flag controls only "can I navigate above the root";
        // the starting points come from `roots`. On Windows with "*" the
        // agent returns one root per drive so we get a multi-root selector
        // instead of being pinned to C:.
        const respRoots = resp.roots ?? [];
        if (respRoots.length === 1) {
          setRoots(null);
          setCurrentPath(respRoots[0]);
        } else if (respRoots.length > 1) {
          setRoots(respRoots);
          setLoading(false);
        } else {
          setError('Agent did not return any browsable roots (agent may be outdated)');
          setLoading(false);
        }
      } catch (err: any) {
        if (cancelled) return;
        setError(mapAuthErrorMessage(err) ?? err.message ?? 'Failed to load roots');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id, mapAuthErrorMessage, refreshKey]);

  const navigate = useCallback((path: string | null) => {
    // Clear any open viewer so the navigation feels responsive — otherwise
    // the breadcrumb click silently reloads the directory behind the viewer
    // and the user sees nothing change until they dismiss it manually.
    setViewingFile(null);
    setViewContent(null);
    setViewError(null);
    setCurrentPath(path);
  }, []);

  const openPathEditor = useCallback(() => {
    setPathInput(currentPath ?? '');
    setPathEditing(true);
  }, [currentPath]);

  const submitPathEditor = useCallback(() => {
    const p = expandTilde(pathInput.trim(), home);
    if (!p) return;
    setPathEditing(false);
    navigate(p);
  }, [pathInput, home, navigate]);

  const submitRootsPath = useCallback(() => {
    const p = expandTilde(rootsPathInput.trim(), home);
    if (!p) return;
    setRootsPathInput('');
    navigate(p);
  }, [rootsPathInput, home, navigate]);

  // Load directory listing when currentPath or refreshKey changes.
  // The agent caps each page at internal/filetransfer/browse.go:maxBrowseLimit
  // (currently 5000). Page with offset until we've collected everything, or
  // stop at MAX_PAGES as a safety cap against runaway listings.
  useEffect(() => {
    if (currentPath === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRenderLimit(RENDER_PAGE);
    const PAGE_SIZE = 5000;
    const MAX_PAGES = 20; // cap at 100,000 entries
    (async () => {
      try {
        const accumulated: FileBrowseEntry[] = [];
        let offset = 0;
        let total = 0;
        let truncatedAtCap = false;
        let canonicalPath: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const resp = await browseFiles(agent.id, 'list', currentPath, offset, PAGE_SIZE);
          if (cancelled) return;
          if (resp.error) {
            setError(mapAuthErrorMessage(resp.error) ?? resp.error);
            setEntries([]);
            setTruncated(null);
            return;
          }
          const pageEntries = resp.entries || [];
          accumulated.push(...pageEntries);
          total = resp.total;
          canonicalPath = resp.path;
          // Show partial results progressively so very large dirs feel responsive.
          setEntries([...accumulated]);
          if (pageEntries.length === 0 || !resp.truncated || accumulated.length >= total) break;
          offset += PAGE_SIZE;
          if (page === MAX_PAGES - 1) truncatedAtCap = true;
        }
        if (cancelled) return;
        setTruncated(truncatedAtCap ? { shown: accumulated.length, total } : null);
        // If the agent expanded/normalized the path (e.g. ~ → /Users/you),
        // adopt the canonical form so the breadcrumb and subsequent
        // joinPath operations use the real path.
        if (canonicalPath && canonicalPath !== currentPath) {
          setCurrentPath(canonicalPath);
        }
      } catch (err: any) {
        if (cancelled) return;
        setError(mapAuthErrorMessage(err) ?? err.message ?? 'Failed to list directory');
        setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id, currentPath, mapAuthErrorMessage, refreshKey]);

  const handleDownload = useCallback(
    async (fullPath: string, fileName: string) => {
      setDownloadingPath(fullPath);
      try {
        const blob = await downloadFile(agent.id, fullPath);
        downloadBlob(blob, fileName);
      } catch (err: any) {
        setUploadMsg({
          type: 'error',
          text: mapAuthErrorMessage(err) ?? err.message ?? 'Download failed',
        });
      } finally {
        setDownloadingPath(null);
      }
    },
    [agent.id, mapAuthErrorMessage],
  );

  // Upload effect — processes uploadQueue sequentially with byte-level
  // progress. Single-file picks go through the same queue so they get
  // progress reporting and a working Cancel button too.
  useEffect(() => {
    if (!uploadQueue || uploadQueue.length === 0) return;
    uploadCancelledRef.current = false;
    const abortController = new AbortController();
    uploadAbortRef.current = abortController;
    let active = true;

    (async () => {
      const totalFiles = uploadQueue.length;
      const totalBytes = uploadQueue.reduce((sum, item) => sum + item.file.size, 0);
      let doneFiles = 0;
      let failed = 0;
      let completedBytes = 0;

      setUploadProgress({
        totalFiles,
        doneFiles: 0,
        failed: 0,
        totalBytes,
        uploadedBytes: 0,
        currentName: uploadQueue[0].file.name,
      });

      for (const item of uploadQueue) {
        if (!active || uploadCancelledRef.current) break;
        const baseBytes = completedBytes;
        setUploadProgress({
          totalFiles,
          doneFiles,
          failed,
          totalBytes,
          uploadedBytes: baseBytes,
          currentName: item.file.name,
        });
        try {
          await uploadFile(
            agent.id,
            item.file,
            item.remotePath,
            loaded => {
              if (!active) return;
              setUploadProgress({
                totalFiles,
                doneFiles,
                failed,
                totalBytes,
                uploadedBytes: baseBytes + loaded,
                currentName: item.file.name,
              });
            },
            abortController.signal,
          );
        } catch {
          // An abort is the operator pressing Cancel, not a failure.
          if (!abortController.signal.aborted) failed++;
        }
        if (uploadCancelledRef.current) break;
        completedBytes += item.file.size;
        doneFiles++;
      }

      if (!active) return;
      const cancelled = uploadCancelledRef.current;
      const skipped = totalFiles - doneFiles;

      uploadAbortRef.current = null;
      setUploadProgress(null);
      setUploadQueue(null);
      doRefresh();

      let text: string;
      if (cancelled) {
        text = `Uploaded ${doneFiles - failed} of ${totalFiles} (${skipped} skipped${failed > 0 ? `, ${failed} failed` : ''})`;
      } else if (failed > 0) {
        text = `Uploaded ${doneFiles - failed} of ${totalFiles} (${failed} failed)`;
      } else {
        text = `Uploaded ${doneFiles} file${doneFiles !== 1 ? 's' : ''}`;
      }
      const msgType = failed > 0 || cancelled ? 'error' : 'success';
      setUploadMsg({ type: msgType, text });
    })();

    return () => {
      active = false;
      // Unmounting mid-upload (panel tab switch, panel close) aborts the
      // in-flight XHR rather than letting it run to completion invisibly.
      abortController.abort();
      if (uploadAbortRef.current === abortController) uploadAbortRef.current = null;
    };
  }, [uploadQueue, agent.id, doRefresh]);

  // Drag event handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragOver(false);
      if (!currentPath || uploadQueue) return; // already uploading

      const items = e.dataTransfer.items;
      if (!items || items.length === 0) return;

      const files = await collectDroppedFiles(items);
      if (files.length === 0) return;

      const queue = files.map(f => ({
        file: f.file,
        remotePath: joinPath(currentPath, f.relativePath),
      }));
      setUploadQueue(queue);
    },
    [currentPath, uploadQueue],
  );

  const handleView = useCallback(
    async (fullPath: string, name: string, size: number) => {
      setViewingFile({ path: fullPath, name, size });
      setViewContent(null);
      setViewError(null);
      setViewLoading(true);
      // Revoke previous blob URL
      setViewImageUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      const previewable = isPreviewable(name);
      setViewTab('preview');
      try {
        const blob = await downloadFile(agent.id, fullPath);
        if (previewable) {
          // Re-wrap blob with correct MIME type so the browser renders it
          // instead of treating it as a download (agent returns application/octet-stream)
          const mime = isPdfFile(name)
            ? 'application/pdf'
            : name.toLowerCase().endsWith('.svg')
              ? 'image/svg+xml'
              : blob.type || 'application/octet-stream';
          const typed = new Blob([blob], { type: mime });
          setViewImageUrl(URL.createObjectURL(typed));
        }
        const buf = new Uint8Array(await blob.arrayBuffer());
        if (isBinaryContent(buf)) {
          const dump = formatHexDump(buf);
          setViewContent({ type: 'binary', text: dump.text, truncated: dump.truncated });
          if (!previewable) setViewTab('hex');
        } else {
          setViewContent({ type: 'text', text: new TextDecoder('utf-8').decode(buf) });
        }
      } catch (err: any) {
        setViewError(mapAuthErrorMessage(err) ?? err.message ?? 'Failed to load file');
      } finally {
        setViewLoading(false);
      }
    },
    [agent.id, mapAuthErrorMessage],
  );

  const closeViewer = useCallback(() => {
    setViewingFile(null);
    setViewContent(null);
    setViewError(null);
    setViewImageUrl(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  // Revoke the viewer's blob URL on unmount too — the revoke paths above
  // only cover opening another file or closing the viewer, so switching
  // panel tabs with a preview open would otherwise leak the object URL.
  const viewImageUrlRef = useRef<string | null>(null);
  useEffect(() => {
    viewImageUrlRef.current = viewImageUrl;
  }, [viewImageUrl]);
  useEffect(
    () => () => {
      if (viewImageUrlRef.current) URL.revokeObjectURL(viewImageUrlRef.current);
    },
    [],
  );

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (menuOpenPath === null) return;
    const onClick = () => setMenuOpenPath(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpenPath(null);
    };
    // Delay to avoid closing immediately from the click that opened it
    const timer = setTimeout(() => {
      window.addEventListener('click', onClick);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpenPath]);

  // Escape closes the chmod dialog, else the viewer. The delete dialog is a
  // ConfirmDialog, which installs its own Escape handler, so this one stands
  // down while it is open rather than closing both layers on one press.
  useEffect(() => {
    if (deleteTarget) return;
    if (!viewingFile && !chmodTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (chmodTarget) {
          setChmodTarget(null);
        } else {
          closeViewer();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewingFile, chmodTarget, deleteTarget, closeViewer]);

  // Open chmod dialog
  const openChmod = useCallback((path: string, name: string, mode: string) => {
    const formatted = formatMode(mode);
    setChmodTarget({ path, name, mode: formatted });
    setChmodValue(formatted);
    setChmodError(null);
    setChmodSaving(false);
  }, []);

  // Save chmod
  const handleChmodSave = useCallback(async () => {
    if (!chmodTarget) return;
    const parsed = parseOctalMode(chmodValue);
    if (parsed === null) {
      setChmodError('Invalid octal mode');
      return;
    }
    const modeStr = toOctalString(parsed);
    setChmodSaving(true);
    setChmodError(null);
    try {
      const resp = await chmodFile(agent.id, chmodTarget.path, modeStr);
      if (resp.error) {
        setChmodError(mapAuthErrorMessage(resp.error) ?? resp.error);
        return;
      }
      setEntries(prev =>
        prev.map(e =>
          joinPath(currentPath!, e.name) === chmodTarget.path
            ? { ...e, mode: resp.entry?.mode ?? modeStr }
            : e,
        ),
      );
      setChmodTarget(null);
    } catch (err: any) {
      setChmodError(mapAuthErrorMessage(err) ?? err.message ?? 'chmod failed');
    } finally {
      setChmodSaving(false);
    }
  }, [agent.id, chmodTarget, chmodValue, currentPath, mapAuthErrorMessage]);

  // Open delete dialog
  const openDelete = useCallback((path: string, name: string, isDir: boolean) => {
    setDeleteTarget({ path, name, isDir });
    setDeleteError(null);
    setDeleteDeleting(false);
  }, []);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteDeleting(true);
    setDeleteError(null);
    try {
      const resp = await deleteFile(agent.id, deleteTarget.path, deleteTarget.isDir);
      if (resp.error) {
        setDeleteError(mapAuthErrorMessage(resp.error) ?? resp.error);
        return;
      }
      setDeleteTarget(null);
      setEntries(prev => prev.filter(e => joinPath(currentPath!, e.name) !== deleteTarget.path));
      setUploadMsg({ type: 'success', text: `Deleted ${deleteTarget.name}` });
    } catch (err: any) {
      setDeleteError(mapAuthErrorMessage(err) ?? err.message ?? 'Delete failed');
    } finally {
      setDeleteDeleting(false);
    }
  }, [agent.id, deleteTarget, currentPath, mapAuthErrorMessage]);

  // Derive rwx bits from chmodValue for the checkbox grid
  const chmodParsed = parseOctalMode(chmodValue);
  const chmodBits = chmodParsed !== null ? modeToBits(chmodParsed) : null;

  const toggleBit = useCallback(
    (group: number, perm: number) => {
      if (chmodBits === null || chmodParsed === null) return;
      const newBits = chmodBits.map(row => [...row]);
      newBits[group][perm] = !newBits[group][perm];
      const newMode = bitsToMode(newBits, chmodParsed);
      setChmodValue(toOctalString(newMode));
    },
    [chmodBits, chmodParsed],
  );

  if (disabled) {
    return <div className="ui-disabled-msg">File transfer is not enabled on this agent</div>;
  }

  // Root picker view
  if (roots !== null && currentPath === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {loading ? (
          <div className="ui-loading p-3">Loading...</div>
        ) : error ? (
          <div className="ui-error-wrap">
            <div className="ui-error">{error}</div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="ui-section-header rounded-t-box">Browsable paths</div>
            {roots.map(root => (
              <button
                key={root}
                type="button"
                className="routes-list-item hover:bg-base-200 w-full text-start font-mono"
                onClick={() => navigate(root)}
              >
                {root}
              </button>
            ))}
            {wildcard && (
              <form
                className="space-y-1.5"
                onSubmit={e => {
                  e.preventDefault();
                  submitRootsPath();
                }}
              >
                <div className="ui-section-header rounded-t-box">Or go to path</div>
                <div className="flex items-center gap-1.5">
                  <input
                    className="input input-sm min-w-0 flex-1 font-mono"
                    value={rootsPathInput}
                    onChange={e => setRootsPathInput(e.target.value)}
                    placeholder={
                      isWindowsAgent(agent)
                        ? home
                          ? '~ or C:\\path'
                          : 'C:\\path'
                        : home
                          ? '~ or /path'
                          : '/path'
                    }
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="btn btn-xs btn-soft"
                    disabled={!rootsPathInput.trim()}
                  >
                    Go
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    );
  }

  const parent = currentPath ? parentPath(currentPath) : null;
  const segments = currentPath ? pathSegments(currentPath) : [];
  // If we're sitting at one of the multi-root entries (e.g. on Windows
  // wildcard the user picked C:\ from a list of C:\, D:\, ...), the up
  // button should return to the drive selector even though parentPath
  // is null at a drive root.
  const atMultiRootEntry = currentPath !== null && roots !== null && roots.includes(currentPath);
  // If non-wildcard with roots, don't allow navigating above the root
  const canGoUp =
    atMultiRootEntry ||
    (parent !== null &&
      (wildcard || !roots || roots.some(r => parent.startsWith(r) || r.startsWith(parent))));
  const goUp = () => {
    if (atMultiRootEntry) {
      navigate(null);
    } else if (parent !== null) {
      navigate(parent);
    }
  };

  const entryFullPath = (entry: FileBrowseEntry) => joinPath(currentPath!, entry.name);

  const showDropOverlay = dragOver && !viewingFile && roots === null;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-2"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showDropOverlay && (
        <div className="border-primary/50 bg-primary/10 rounded-box pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed">
          <div className="border-primary/40 rounded-box bg-base-100 text-primary border px-5 py-2 font-semibold shadow-lg">
            Drop files to upload
          </div>
        </div>
      )}
      {/* Toolbar: Up + breadcrumb (or path input) + actions.
          All buttons share the same visual weight; drag-and-drop carries
          the primary upload spotlight via the drop overlay. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="btn btn-xs btn-soft"
            onClick={goUp}
            disabled={!canGoUp}
            title="Up one directory"
          >
            Up
          </button>
        </div>
        {pathEditing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={e => {
              e.preventDefault();
              submitPathEditor();
            }}
          >
            <input
              className="input input-sm min-w-0 flex-1 font-mono"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setPathEditing(false);
              }}
              placeholder={
                isWindowsAgent(agent)
                  ? home
                    ? '~ or C:\\path'
                    : 'C:\\path'
                  : home
                    ? '~ or /path'
                    : '/path'
              }
              spellCheck={false}
              autoFocus
            />
            <button
              type="submit"
              className="btn btn-xs btn-soft"
              disabled={!pathInput.trim()}
              title="Go to path"
            >
              Go
            </button>
            <button
              type="button"
              className="btn btn-xs btn-soft"
              onClick={() => setPathEditing(false)}
              title="Cancel (Esc)"
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono">
            {isWindowsAgent(agent) ? (
              // Windows has no single root. When a multi-root selector
              // is available, "Drives" returns to it; otherwise no
              // leading segment. The Path toolbar button is the
              // primary way to enter the editor on Windows.
              roots !== null && (
                <button className="text-primary hover:underline" onClick={() => navigate(null)}>
                  Drives
                </button>
              )
            ) : (
              // Linux: clicking "/" opens the path editor (Explorer-style
              // "click the address bar to type"), regardless of wildcard
              // mode — useful even when the user can't actually list /,
              // because they may want to type a sibling path.
              <button
                className="text-primary hover:underline"
                onClick={openPathEditor}
                title="Edit path"
              >
                /
              </button>
            )}
            {segments.map((seg, i) => (
              <span key={seg.path}>
                {i > 0 && <span className="text-base-content/40">/</span>}
                {i < segments.length - 1 ? (
                  <button
                    className="text-primary hover:underline"
                    onClick={() => navigate(seg.path)}
                  >
                    {seg.name}
                  </button>
                ) : viewingFile ? (
                  <button className="text-primary hover:underline" onClick={closeViewer}>
                    {seg.name}
                  </button>
                ) : (
                  <span className="text-base-content">{seg.name}</span>
                )}
              </span>
            ))}
          </div>
        )}
        {!pathEditing && (
          <div className="flex shrink-0 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const files = e.target.files;
                if (!files || files.length === 0 || !currentPath) return;
                // One file or many — always go through the upload queue so
                // every upload gets progress reporting and a working Cancel.
                const queue = Array.from(files).map(f => ({
                  file: f,
                  remotePath: joinPath(currentPath, f.name),
                }));
                setUploadQueue(queue);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
            <button className="btn btn-xs btn-soft" onClick={openPathEditor} title="Edit path">
              Path
            </button>
            <button
              className="btn btn-xs btn-soft"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadQueue !== null}
              title="Upload (or drop files anywhere here)"
            >
              {uploadQueue !== null ? 'Uploading…' : 'Upload'}
            </button>
            <button
              className="btn btn-xs btn-soft"
              onClick={doRefresh}
              disabled={loading}
              title="Refresh"
            >
              Refresh
            </button>
            <button
              className="btn btn-xs btn-soft"
              onClick={() => currentPath && setSharingPath(currentPath)}
              disabled={!currentPath || !!viewingFile}
              title="Share this folder over WebDAV"
            >
              Share
            </button>
          </div>
        )}
      </div>
      {sharingPath && (
        <ShareFolderDialog
          agentId={agent.id}
          agentLabel={agentLabel(agent)}
          remotePath={sharingPath}
          onClose={() => setSharingPath(null)}
        />
      )}

      {/* Upload progress */}
      {uploadProgress && (
        <UploadProgressBar
          progress={uploadProgress}
          onCancel={() => {
            uploadCancelledRef.current = true;
            // Abort the in-flight XHR immediately instead of waiting for the
            // current file to finish uploading.
            uploadAbortRef.current?.abort();
          }}
        />
      )}

      {viewingFile ? (
        /* File viewer */
        <div className="rounded-box border-hairline flex min-h-0 flex-1 flex-col overflow-hidden border">
          <div className="border-hairline flex flex-none items-center gap-2 border-b px-2 py-1.5">
            <span className="min-w-0 truncate font-mono font-medium" title={viewingFile.path}>
              {viewingFile.name}
            </span>
            <span className="text-muted shrink-0 font-mono text-xs">
              {formatSize(viewingFile.size)}
            </span>
            {viewContent && !viewImageUrl && (
              <span
                className={`badge badge-xs badge-soft ${viewContent.type === 'text' ? 'badge-info' : 'badge-warning'}`}
              >
                {viewContent.type === 'text' ? 'TEXT' : 'BIN'}
              </span>
            )}
            {viewImageUrl && viewContent && (
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className={`btn btn-xs ${viewTab === 'preview' ? 'btn-primary' : 'btn-text'}`}
                  onClick={() => setViewTab('preview')}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className={`btn btn-xs ${viewTab === 'hex' ? 'btn-primary' : 'btn-text'}`}
                  onClick={() => setViewTab('hex')}
                >
                  Hex
                </button>
              </span>
            )}
            <button
              type="button"
              className="btn btn-text btn-xs btn-square ms-auto"
              title="Download"
              aria-label="Download"
              onClick={() => handleDownload(viewingFile.path, viewingFile.name)}
            >
              <span className="icon-[tabler--download] size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-text btn-xs btn-square"
              onClick={closeViewer}
              title="Close"
              aria-label="Close viewer"
            >
              <span className="icon-[tabler--x] size-3.5" aria-hidden="true" />
            </button>
          </div>
          {viewLoading ? (
            <div className="ui-loading p-3">Loading...</div>
          ) : viewError ? (
            <div className="ui-error m-2">{viewError}</div>
          ) : viewImageUrl && viewTab === 'preview' && isPdfFile(viewingFile.name) ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <embed
                src={viewImageUrl + '#navpanes=0'}
                type="application/pdf"
                className="h-full w-full"
              />
            </div>
          ) : viewImageUrl && viewTab === 'preview' ? (
            <div className="bg-base-200 flex min-h-0 flex-1 items-start justify-center overflow-auto p-4">
              <img
                src={viewImageUrl}
                alt={viewingFile.name}
                className="rounded-field max-h-full max-w-full object-contain"
              />
            </div>
          ) : viewContent ? (
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2">
              <pre className="m-0 font-mono text-xs leading-snug whitespace-pre select-all">
                {viewContent.text}
              </pre>
              {viewContent.truncated && (
                <div className="text-warning mt-2 text-xs">
                  Hex dump truncated to 1 MB ({formatSize(viewingFile.size)} total)
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* Upload feedback */}
          {uploadMsg && (
            // Successes clear themselves after 4s; a failure stays until the
            // operator dismisses it.
            <Alert
              kind={uploadMsg.type}
              message={uploadMsg.text}
              autoCloseMs={uploadMsg.type === 'error' ? 0 : 4000}
              onClose={() => setUploadMsg(null)}
            />
          )}

          {/* Error */}
          {error && (
            <div className="ui-error-wrap">
              <div className="ui-error">{error}</div>
            </div>
          )}

          {truncated && (
            <div className="ui-error-wrap">
              <div className="ui-hint">
                Showing {truncated.shown} of {truncated.total} entries. The rest was dropped at Muti
                Metroo Manager's 100,000-entry safety cap.
              </div>
            </div>
          )}

          {/* File list */}
          {loading ? (
            <div className="ui-loading p-3">Loading...</div>
          ) : !error && entries.length === 0 && !canGoUp ? (
            <div className="ui-empty">Directory is empty</div>
          ) : (
            <div className="ui-table-frame">
              {/* Parent directory row (or drive selector when at a multi-root entry) */}
              {canGoUp && (
                <div className={`${FILE_ROW} cursor-pointer`} onClick={goUp}>
                  <span className="w-4 shrink-0 text-center">&#x1F4C1;</span>
                  <span className="min-w-0 flex-1 truncate font-mono">..</span>
                </div>
              )}
              {entries.slice(0, renderLimit).map(entry => {
                const fullPath = entryFullPath(entry);
                const isDownloading = downloadingPath === fullPath;
                const canView = !entry.is_dir && entry.size <= VIEW_MAX_SIZE;
                const isMenuOpen = menuOpenPath === fullPath;
                return (
                  <div
                    key={entry.name}
                    className={`${FILE_ROW}${entry.is_dir || canView ? ' cursor-pointer' : ''}`}
                    onClick={() => {
                      if (entry.is_dir) navigate(fullPath);
                      else if (canView) handleView(fullPath, entry.name, entry.size);
                    }}
                  >
                    <span className="w-4 shrink-0 text-center">{entryIcon(entry)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {entry.name}
                      {entry.is_symlink && entry.link_target && (
                        <span className="text-muted">
                          {' '}
                          {'\u2192'} {entry.link_target}
                        </span>
                      )}
                    </span>
                    <span className="text-muted w-20 shrink-0 text-end font-mono text-xs">
                      {entry.is_dir ? '\u2014' : formatSize(entry.size)}
                    </span>
                    <span className="text-muted hidden w-24 shrink-0 font-mono text-xs sm:inline">
                      {formatMode(entry.mode)}
                    </span>
                    <span className="relative shrink-0">
                      <button
                        type="button"
                        className={`btn btn-text btn-xs btn-square${isMenuOpen ? ' btn-active' : ''}`}
                        title="Actions"
                        aria-label={`Actions for ${entry.name}`}
                        aria-haspopup="menu"
                        aria-expanded={isMenuOpen}
                        disabled={isDownloading}
                        onClick={e => {
                          e.stopPropagation();
                          setMenuOpenPath(isMenuOpen ? null : fullPath);
                        }}
                      >
                        <span
                          className={`size-3.5 ${isDownloading ? 'icon-[tabler--loader-2] animate-spin' : 'icon-[tabler--dots-vertical]'}`}
                          aria-hidden="true"
                        />
                      </button>
                      {isMenuOpen && (
                        <div
                          role="menu"
                          className="ui-popover end-0 top-full mt-0.5 min-w-44"
                          onClick={e => e.stopPropagation()}
                        >
                          {canView && (
                            <button
                              className="dropdown-item py-1.5"
                              onClick={() => {
                                setMenuOpenPath(null);
                                handleView(fullPath, entry.name, entry.size);
                              }}
                            >
                              <span className="w-4 shrink-0 text-center">&#x1F441;</span>
                              View
                            </button>
                          )}
                          <button
                            className="dropdown-item py-1.5"
                            disabled={isDownloading}
                            onClick={() => {
                              setMenuOpenPath(null);
                              handleDownload(
                                fullPath,
                                entry.is_dir ? entry.name + '.tar.gz' : entry.name,
                              );
                            }}
                          >
                            <span className="w-4 shrink-0 text-center">&#x2B07;</span>
                            {entry.is_dir ? 'Download as tar.gz' : 'Download'}
                          </button>
                          <button
                            className="dropdown-item py-1.5"
                            onClick={() => {
                              setMenuOpenPath(null);
                              openChmod(fullPath, entry.name, entry.mode);
                            }}
                          >
                            <span className="w-4 shrink-0 text-center">&#x1F512;</span>
                            Permissions
                          </button>
                          <button
                            className="dropdown-item text-error py-1.5"
                            onClick={() => {
                              setMenuOpenPath(null);
                              openDelete(fullPath, entry.name, entry.is_dir);
                            }}
                          >
                            <span className="w-4 shrink-0 text-center">&#x2715;</span>
                            Delete
                          </button>
                        </div>
                      )}
                    </span>
                  </div>
                );
              })}
              {entries.length > renderLimit && (
                <div className={`${FILE_ROW} justify-center`}>
                  <button
                    type="button"
                    className="btn btn-xs btn-soft"
                    onClick={() => setRenderLimit(limit => limit + RENDER_PAGE)}
                  >
                    Show more ({entries.length - renderLimit} hidden)
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <ConfirmDialog
          title={deleteTarget.isDir ? 'Delete folder' : 'Delete file'}
          target={deleteTarget.name}
          message={
            deleteTarget.isDir
              ? 'Are you sure you want to delete this folder and all its contents?'
              : 'Are you sure you want to delete this file?'
          }
          tone={deleteTarget.isDir ? 'warning' : 'normal'}
          confirmLabel="Delete"
          pendingLabel="Deleting..."
          loading={deleteDeleting}
          error={deleteError}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}

      {/* Chmod dialog */}
      {chmodTarget && (
        <div className="ui-overlay" onClick={() => setChmodTarget(null)}>
          <div
            className="ui-dialog max-w-sm"
            role="dialog"
            aria-modal="true"
            aria-label="Permissions"
            onClick={e => e.stopPropagation()}
          >
            <div className="ui-dialog-header">
              <span>Permissions</span>
              <button
                type="button"
                className="btn btn-text btn-xs btn-square"
                aria-label="Close"
                onClick={() => setChmodTarget(null)}
              >
                <span className="icon-[tabler--x] size-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="ui-dialog-body space-y-3">
              <div className="font-mono break-all">{chmodTarget.name}</div>
              <div className="flex items-center gap-2">
                <label htmlFor="chmod-mode" className="text-muted">
                  Mode
                </label>
                <input
                  id="chmod-mode"
                  className={`input input-sm w-24 font-mono ${chmodParsed === null ? 'is-invalid' : ''}`}
                  value={chmodValue}
                  onChange={e => setChmodValue(e.target.value)}
                  maxLength={5}
                  spellCheck={false}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && chmodParsed !== null) handleChmodSave();
                  }}
                />
              </div>
              <div className="grid grid-cols-[4.5rem_repeat(3,1fr)] items-center gap-y-1 text-center text-xs">
                <div />
                <div className="text-muted">Owner</div>
                <div className="text-muted">Group</div>
                <div className="text-muted">Other</div>
                {['Read', 'Write', 'Execute'].map((label, perm) => (
                  <div key={label} className="contents">
                    <div className="text-start">{label}</div>
                    {[0, 1, 2].map(group => (
                      <div key={group} className="flex justify-center">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm checkbox-primary"
                          checked={chmodBits ? chmodBits[group][perm] : false}
                          disabled={chmodBits === null}
                          onChange={() => toggleBit(group, perm)}
                          aria-label={`${label} for ${['owner', 'group', 'other'][group]}`}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="ui-dialog-footer">
              {chmodError && (
                <span className="text-error me-auto" role="alert">
                  {chmodError}
                </span>
              )}
              <button
                type="button"
                className="btn btn-sm btn-text"
                onClick={() => setChmodTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={chmodSaving || chmodParsed === null}
                onClick={handleChmodSave}
              >
                {chmodSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
