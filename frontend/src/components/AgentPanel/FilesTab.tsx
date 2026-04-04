import { useState, useEffect, useCallback, useRef } from 'react';
import type { TopologyAgentInfo, FileBrowseEntry } from '../../api/types';
import { ERR_FILE_TRANSFER_DENIED } from '../../api/types';
import { browseFiles, downloadFile, uploadFile, chmodFile, deleteFile } from '../../api/client';

const VIEW_MAX_SIZE = 1024 * 1024; // 1MB

interface FilesTabProps {
  agent: TopologyAgentInfo;
  disabled: boolean;
  onDisabled: () => void;
}

function isBinaryContent(buf: Uint8Array): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b <= 0x08 || (b >= 0x0E && b <= 0x1F)) return true;
  }
  return false;
}

function formatHexDump(buf: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const chunk = buf.subarray(off, Math.min(off + 16, buf.length));
    const offset = off.toString(16).padStart(8, '0');
    let hex1 = '';
    let hex2 = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const h = chunk[i].toString(16).padStart(2, '0');
        if (i < 8) hex1 += h + ' ';
        else hex2 += h + ' ';
        ascii += (chunk[i] >= 0x20 && chunk[i] <= 0x7E) ? String.fromCharCode(chunk[i]) : '.';
      } else {
        if (i < 8) hex1 += '   ';
        else hex2 += '   ';
        ascii += ' ';
      }
    }
    lines.push(`${offset}  ${hex1} ${hex2} |${ascii}|`);
  }
  return lines.join('\n');
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
async function collectDroppedFiles(items: DataTransferItemList): Promise<{ file: File; relativePath: string }[]> {
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

interface UploadProgressBarProps {
  progress: UploadProgress;
  onCancel: () => void;
}

function UploadProgressBar({ progress, onCancel }: UploadProgressBarProps) {
  const pct = progress.totalBytes > 0
    ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100)
    : 0;

  return (
    <div className="files-upload-progress">
      <div className="files-upload-progress-bar-wrap">
        <div className="files-upload-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="files-upload-progress-info">
        <span className="files-upload-progress-text">
          {progress.doneFiles}/{progress.totalFiles}
          {progress.failed > 0 && <span className="failed"> ({progress.failed} failed)</span>}
          {' \u2014 '}{progress.currentName}
        </span>
        <span className="files-upload-progress-bytes">
          {pct}% {formatSize(progress.uploadedBytes)}/{formatSize(progress.totalBytes)}
        </span>
        <button className="files-upload-progress-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function FilesTab({ agent, disabled, onDisabled }: FilesTabProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileBrowseEntry[]>([]);
  const [roots, setRoots] = useState<string[] | null>(null);
  const [wildcard, setWildcard] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [viewContent, setViewContent] = useState<{ type: 'text' | 'binary'; text: string } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  // Context menu state
  const [menuOpenPath, setMenuOpenPath] = useState<string | null>(null);
  // Chmod dialog state
  const [chmodTarget, setChmodTarget] = useState<{ path: string; name: string; mode: string } | null>(null);
  const [chmodValue, setChmodValue] = useState('');
  const [chmodSaving, setChmodSaving] = useState(false);
  const [chmodError, setChmodError] = useState<string | null>(null);
  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string; isDir: boolean } | null>(null);
  const [deleteDeleting, setDeleteDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ file: File; remotePath: string }[] | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const dragCounter = useRef(0);
  const uploadCancelledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadMsgTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onDisabledRef = useRef(onDisabled);
  onDisabledRef.current = onDisabled;

  const checkFileTransferDenied = useCallback((err: any) => {
    const msg = err.message || '';
    if (msg.includes(String(ERR_FILE_TRANSFER_DENIED)) || msg.includes('ERR_FILE_TRANSFER_DENIED')) {
      onDisabledRef.current();
    }
  }, []);

  // Load roots on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await browseFiles(agent.id, 'roots');
        if (cancelled) return;
        setWildcard(resp.wildcard);
        if (resp.wildcard) {
          setRoots(null);
          setCurrentPath(agent.os === 'windows' ? 'C:\\' : '/');
        } else if (resp.roots.length === 1) {
          setRoots(null);
          setCurrentPath(resp.roots[0]);
        } else {
          setRoots(resp.roots);
          setLoading(false);
        }
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to load roots');
        setLoading(false);
        checkFileTransferDenied(err);
      }
    })();
    return () => { cancelled = true; };
  }, [agent.id, checkFileTransferDenied]);

  const [refreshKey, setRefreshKey] = useState(0);

  const doRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  const navigate = setCurrentPath;

  // Load directory listing when currentPath or refreshKey changes
  useEffect(() => {
    if (currentPath === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await browseFiles(agent.id, 'list', currentPath);
        if (cancelled) return;
        if (resp.error) {
          setError(resp.error);
          setEntries([]);
        } else {
          setEntries(resp.entries || []);
        }
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to list directory');
        setEntries([]);
        checkFileTransferDenied(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agent.id, currentPath, checkFileTransferDenied, refreshKey]);

  const handleDownload = useCallback(async (fullPath: string, fileName: string) => {
    setDownloadingPath(fullPath);
    try {
      const blob = await downloadFile(agent.id, fullPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setUploadMsg({ type: 'error', text: err.message || 'Download failed' });
      clearTimeout(uploadMsgTimer.current);
      uploadMsgTimer.current = setTimeout(() => setUploadMsg(null), 4000);
      checkFileTransferDenied(err);
    } finally {
      setDownloadingPath(null);
    }
  }, [agent.id, checkFileTransferDenied]);

  const handleUpload = useCallback(async (file: File) => {
    if (!currentPath) return;
    const remotePath = joinPath(currentPath, file.name);
    setUploading(true);
    setUploadMsg(null);
    try {
      await uploadFile(agent.id, file, remotePath);
      setUploadMsg({ type: 'success', text: `Uploaded ${file.name}` });
      doRefresh();
    } catch (err: any) {
      setUploadMsg({ type: 'error', text: err.message || 'Upload failed' });
      checkFileTransferDenied(err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      clearTimeout(uploadMsgTimer.current);
      uploadMsgTimer.current = setTimeout(() => setUploadMsg(null), 4000);
    }
  }, [agent.id, currentPath, checkFileTransferDenied, doRefresh]);

  // Batch upload effect — processes uploadQueue sequentially with byte-level progress
  useEffect(() => {
    if (!uploadQueue || uploadQueue.length === 0) return;
    uploadCancelledRef.current = false;
    let active = true;

    (async () => {
      const totalFiles = uploadQueue.length;
      const totalBytes = uploadQueue.reduce((sum, item) => sum + item.file.size, 0);
      let doneFiles = 0;
      let failed = 0;
      let completedBytes = 0;

      setUploadProgress({ totalFiles, doneFiles: 0, failed: 0, totalBytes, uploadedBytes: 0, currentName: uploadQueue[0].file.name });

      for (const item of uploadQueue) {
        if (!active || uploadCancelledRef.current) break;
        const baseBytes = completedBytes;
        setUploadProgress({ totalFiles, doneFiles, failed, totalBytes, uploadedBytes: baseBytes, currentName: item.file.name });
        try {
          await uploadFile(agent.id, item.file, item.remotePath, (loaded) => {
            if (!active) return;
            setUploadProgress({ totalFiles, doneFiles, failed, totalBytes, uploadedBytes: baseBytes + loaded, currentName: item.file.name });
          });
        } catch {
          failed++;
        }
        completedBytes += item.file.size;
        doneFiles++;
      }

      if (!active) return;
      const cancelled = uploadCancelledRef.current;
      const skipped = totalFiles - doneFiles;

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
      setUploadMsg({ type: failed > 0 || cancelled ? 'error' : 'success', text });
      clearTimeout(uploadMsgTimer.current);
      uploadMsgTimer.current = setTimeout(() => setUploadMsg(null), 4000);
    })();

    return () => { active = false; };
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

  const handleDrop = useCallback(async (e: React.DragEvent) => {
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
  }, [currentPath, uploadQueue]);

  const handleView = useCallback(async (fullPath: string, name: string, size: number) => {
    setViewingFile({ path: fullPath, name, size });
    setViewContent(null);
    setViewError(null);
    setViewLoading(true);
    try {
      const blob = await downloadFile(agent.id, fullPath);
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (isBinaryContent(buf)) {
        setViewContent({ type: 'binary', text: formatHexDump(buf) });
      } else {
        setViewContent({ type: 'text', text: new TextDecoder('utf-8').decode(buf) });
      }
    } catch (err: any) {
      setViewError(err.message || 'Failed to load file');
      checkFileTransferDenied(err);
    } finally {
      setViewLoading(false);
    }
  }, [agent.id, checkFileTransferDenied]);

  const closeViewer = useCallback(() => {
    setViewingFile(null);
    setViewContent(null);
    setViewError(null);
  }, []);

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

  // Escape key closes viewer, chmod dialog, or delete dialog
  useEffect(() => {
    if (!viewingFile && !chmodTarget && !deleteTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteTarget) {
          setDeleteTarget(null);
        } else if (chmodTarget) {
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
        setChmodError(resp.error);
        return;
      }
      setEntries(prev => prev.map(e =>
        joinPath(currentPath!, e.name) === chmodTarget.path
          ? { ...e, mode: resp.entry?.mode ?? modeStr }
          : e
      ));
      setChmodTarget(null);
    } catch (err: any) {
      setChmodError(err.message || 'chmod failed');
      checkFileTransferDenied(err);
    } finally {
      setChmodSaving(false);
    }
  }, [agent.id, chmodTarget, chmodValue, currentPath, checkFileTransferDenied]);

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
        setDeleteError(resp.error);
        return;
      }
      setDeleteTarget(null);
      setEntries(prev => prev.filter(e => joinPath(currentPath!, e.name) !== deleteTarget.path));
      setUploadMsg({ type: 'success', text: `Deleted ${deleteTarget.name}` });
      clearTimeout(uploadMsgTimer.current);
      uploadMsgTimer.current = setTimeout(() => setUploadMsg(null), 4000);
    } catch (err: any) {
      setDeleteError(err.message || 'Delete failed');
      checkFileTransferDenied(err);
    } finally {
      setDeleteDeleting(false);
    }
  }, [agent.id, deleteTarget, currentPath, checkFileTransferDenied]);

  // Derive rwx bits from chmodValue for the checkbox grid
  const chmodParsed = parseOctalMode(chmodValue);
  const chmodBits = chmodParsed !== null ? modeToBits(chmodParsed) : null;

  const toggleBit = useCallback((group: number, perm: number) => {
    if (chmodBits === null || chmodParsed === null) return;
    const newBits = chmodBits.map(row => [...row]);
    newBits[group][perm] = !newBits[group][perm];
    const newMode = bitsToMode(newBits, chmodParsed);
    setChmodValue(toOctalString(newMode));
  }, [chmodBits, chmodParsed]);

  if (disabled) {
    return (
      <div className="tab-disabled-msg">
        File transfer is not enabled on this agent
      </div>
    );
  }

  // Root picker view
  if (roots !== null && currentPath === null) {
    return (
      <div className="files-tab">
        {loading ? (
          <div className="files-loading">Loading...</div>
        ) : error ? (
          <div className="tab-error-wrap"><div className="tab-error">{error}</div></div>
        ) : (
          <div className="files-roots">
            <div className="files-roots-title">Browsable Paths</div>
            {roots.map(root => (
              <div key={root} className="files-root-item" onClick={() => navigate(root)}>
                {root}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const parent = currentPath ? parentPath(currentPath) : null;
  const segments = currentPath ? pathSegments(currentPath) : [];
  // If non-wildcard with roots, don't allow navigating above the root
  const canGoUp = parent !== null && (wildcard || !roots || roots.some(r => parent.startsWith(r) || r.startsWith(parent)));

  const entryFullPath = (entry: FileBrowseEntry) => joinPath(currentPath!, entry.name);

  const showDropOverlay = dragOver && !viewingFile && roots === null;

  return (
    <div
      className={`files-tab${showDropOverlay ? ' drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showDropOverlay && (
        <div className="files-drop-overlay">
          <div className="files-drop-overlay-text">Drop files to upload</div>
        </div>
      )}
      {/* Toolbar with breadcrumb and actions */}
      <div className="files-toolbar">
        <div className="files-breadcrumb">
          <button className="files-breadcrumb-segment" onClick={() => wildcard && navigate('/')}>
            /
          </button>
          {segments.map((seg, i) => (
            <span key={seg.path}>
              {i > 0 && <span className="files-breadcrumb-sep">/</span>}
              {i < segments.length - 1 ? (
                <button className="files-breadcrumb-segment" onClick={() => navigate(seg.path)}>
                  {seg.name}
                </button>
              ) : (
                <span className="files-breadcrumb-current">{seg.name}</span>
              )}
            </span>
          ))}
        </div>
        <div className="files-toolbar-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => {
              const files = e.target.files;
              if (!files || files.length === 0 || !currentPath) return;
              if (files.length === 1) {
                handleUpload(files[0]);
              } else {
                const queue = Array.from(files).map(f => ({
                  file: f,
                  remotePath: joinPath(currentPath, f.name),
                }));
                setUploadQueue(queue);
              }
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <button
            className="files-toolbar-btn files-toolbar-btn-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || uploadQueue !== null}
          >
            {uploading || uploadQueue !== null ? 'Uploading...' : 'Upload'}
          </button>
          <button className="files-toolbar-btn" onClick={doRefresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {/* Batch upload progress */}
      {uploadProgress && <UploadProgressBar progress={uploadProgress} onCancel={() => { uploadCancelledRef.current = true; }} />}

      {viewingFile ? (
        /* File viewer */
        <div className="files-viewer">
          <div className="files-viewer-header">
            <span className="files-viewer-name" title={viewingFile.path}>{viewingFile.name}</span>
            <span className="files-viewer-size">{formatSize(viewingFile.size)}</span>
            {viewContent && (
              <span className={`files-viewer-badge ${viewContent.type === 'text' ? 'badge-text' : 'badge-bin'}`}>
                {viewContent.type === 'text' ? 'TEXT' : 'BIN'}
              </span>
            )}
            <button
              className="files-viewer-btn"
              title="Download"
              onClick={() => handleDownload(viewingFile.path, viewingFile.name)}
            >
              &#x2B07;
            </button>
            <button className="files-viewer-btn" onClick={closeViewer} title="Close">
              &#x2715;
            </button>
          </div>
          {viewLoading ? (
            <div className="files-loading">Loading...</div>
          ) : viewError ? (
            <div className="files-viewer-error">{viewError}</div>
          ) : viewContent ? (
            <div className="files-viewer-content">
              <pre>{viewContent.text}</pre>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* Upload feedback */}
          {uploadMsg && (
            <div className={`files-upload-msg files-upload-msg-${uploadMsg.type}`}>
              {uploadMsg.text}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="tab-error-wrap">
              <div className="tab-error">{error}</div>
            </div>
          )}

          {/* File list */}
          {loading ? (
            <div className="files-loading">Loading...</div>
          ) : !error && entries.length === 0 && !canGoUp ? (
            <div className="files-empty">Directory is empty</div>
          ) : (
            <div className="files-list">
              {/* Parent directory row */}
              {canGoUp && parent !== null && (
                <div className="files-row files-row-dir" onClick={() => navigate(parent)}>
                  <span className="files-icon">&#x1F4C1;</span>
                  <span className="files-name">..</span>
                  <span className="files-size"></span>
                  <span className="files-mode"></span>
                  <span className="files-actions"></span>
                </div>
              )}
              {entries.map(entry => {
                const fullPath = entryFullPath(entry);
                const isDownloading = downloadingPath === fullPath;
                const canView = !entry.is_dir && entry.size <= VIEW_MAX_SIZE;
                const isMenuOpen = menuOpenPath === fullPath;
                return (
                  <div
                    key={entry.name}
                    className={`files-row ${entry.is_dir ? 'files-row-dir' : canView ? 'files-row-viewable' : ''}`}
                    onClick={() => {
                      if (entry.is_dir) navigate(fullPath);
                      else if (canView) handleView(fullPath, entry.name, entry.size);
                    }}
                  >
                    <span className="files-icon">{entryIcon(entry)}</span>
                    <span className="files-name">
                      {entry.name}
                      {entry.is_symlink && entry.link_target && (
                        <span className="files-name-link">{'\u2192'} {entry.link_target}</span>
                      )}
                    </span>
                    <span className="files-size">
                      {entry.is_dir ? '\u2014' : formatSize(entry.size)}
                    </span>
                    <span className="files-mode">{formatMode(entry.mode)}</span>
                    <span className="files-actions">
                      <button
                        className={`files-menu-btn ${isMenuOpen ? 'menu-open' : ''} ${isDownloading ? 'downloading' : ''}`}
                        title="Actions"
                        onClick={e => {
                          e.stopPropagation();
                          setMenuOpenPath(isMenuOpen ? null : fullPath);
                        }}
                      >
                        &#x22EE;
                      </button>
                      {isMenuOpen && (
                        <div className="files-context-menu" onClick={e => e.stopPropagation()}>
                          {canView && (
                            <button
                              className="files-context-item"
                              onClick={() => {
                                setMenuOpenPath(null);
                                handleView(fullPath, entry.name, entry.size);
                              }}
                            >
                              <span className="files-context-item-icon">&#x1F441;</span>
                              View
                            </button>
                          )}
                          <button
                            className="files-context-item"
                            disabled={isDownloading}
                            onClick={() => {
                              setMenuOpenPath(null);
                              handleDownload(fullPath, entry.is_dir ? entry.name + '.tar.gz' : entry.name);
                            }}
                          >
                            <span className="files-context-item-icon">&#x2B07;</span>
                            {entry.is_dir ? 'Download as tar.gz' : 'Download'}
                          </button>
                          <button
                            className="files-context-item"
                            onClick={() => {
                              setMenuOpenPath(null);
                              openChmod(fullPath, entry.name, entry.mode);
                            }}
                          >
                            <span className="files-context-item-icon">&#x1F512;</span>
                            Permissions
                          </button>
                          <button
                            className="files-context-item files-context-item-danger"
                            onClick={() => {
                              setMenuOpenPath(null);
                              openDelete(fullPath, entry.name, entry.is_dir);
                            }}
                          >
                            <span className="files-context-item-icon">&#x2715;</span>
                            Delete
                          </button>
                        </div>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="delete-dialog-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="delete-dialog" onClick={e => e.stopPropagation()}>
            <div className="delete-dialog-header">
              <span className="delete-dialog-title">{deleteTarget.isDir ? 'Delete Folder' : 'Delete File'}</span>
              <button className="delete-dialog-close" onClick={() => setDeleteTarget(null)}>&#x2715;</button>
            </div>
            <div className="delete-dialog-body">
              <div className="delete-dialog-filename">{deleteTarget.name}</div>
              {deleteTarget.isDir ? (
                <div className="delete-dialog-warning-recursive">
                  Are you sure you want to delete this folder and all its contents?
                </div>
              ) : (
                <div className="delete-dialog-warning">
                  Are you sure you want to delete this file?
                </div>
              )}
            </div>
            <div className="delete-dialog-footer">
              {deleteError && <span className="delete-dialog-error">{deleteError}</span>}
              <div className="delete-dialog-actions">
                <button className="delete-btn-cancel" onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button
                  className="delete-btn-confirm"
                  disabled={deleteDeleting}
                  onClick={handleDelete}
                >
                  {deleteDeleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Chmod dialog */}
      {chmodTarget && (
        <div className="chmod-dialog-overlay" onClick={() => setChmodTarget(null)}>
          <div className="chmod-dialog" onClick={e => e.stopPropagation()}>
            <div className="chmod-dialog-header">
              <span className="chmod-dialog-title">Permissions</span>
              <button className="chmod-dialog-close" onClick={() => setChmodTarget(null)}>&#x2715;</button>
            </div>
            <div className="chmod-dialog-body">
              <div className="chmod-dialog-filename">{chmodTarget.name}</div>
              <div className="chmod-octal-row">
                <span className="chmod-octal-label">Mode</span>
                <input
                  className={`chmod-octal-input ${chmodParsed === null ? 'input-error' : ''}`}
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
              <div className="chmod-rwx-grid">
                <div className="chmod-rwx-header"></div>
                <div className="chmod-rwx-header">Owner</div>
                <div className="chmod-rwx-header">Group</div>
                <div className="chmod-rwx-header">Other</div>
                {['Read', 'Write', 'Execute'].map((label, perm) => (
                  <div key={label} className="chmod-rwx-row">
                    <div className="chmod-rwx-label">{label}</div>
                    {[0, 1, 2].map(group => (
                      <div key={group} className="chmod-rwx-cell">
                        <input
                          type="checkbox"
                          checked={chmodBits ? chmodBits[group][perm] : false}
                          disabled={chmodBits === null}
                          onChange={() => toggleBit(group, perm)}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="chmod-dialog-footer">
              {chmodError && <span className="chmod-dialog-error">{chmodError}</span>}
              <div className="chmod-dialog-actions">
                <button className="chmod-btn-cancel" onClick={() => setChmodTarget(null)}>Cancel</button>
                <button
                  className="chmod-btn-save"
                  disabled={chmodSaving || chmodParsed === null}
                  onClick={handleChmodSave}
                >
                  {chmodSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
