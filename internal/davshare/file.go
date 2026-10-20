package davshare

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"sync"
	"time"

	"golang.org/x/net/webdav"
)

// Read-ahead window for ranged downloads. A read that does not continue
// the previous chunk fetches what the caller asked for, but at least
// minChunk bytes, so a client sampling a file (Finder previews,
// Explorer thumbnails, media seeks) pulls only what it touches. Each
// sequential continuation doubles the window up to maxChunk and
// prefetches the next chunk in the background, so a long sequential
// read pays roughly one agent round trip per maxChunk.
const (
	minChunk = 64 << 10
	maxChunk = 4 << 20
)

var errClosed = errors.New("file already closed")
var errReadOnlyHandle = errors.New("file not opened for writing")

// dirFile is an open collection. Readdir lists lazily.
type dirFile struct {
	fs      *FS
	ctx     context.Context
	full    string
	fi      *fileInfo
	entries []os.FileInfo
	loaded  bool
	pos     int
}

var _ webdav.File = (*dirFile)(nil)

func (d *dirFile) Close() error { return nil }
func (d *dirFile) Read([]byte) (int, error) {
	return 0, &os.PathError{Op: "read", Path: d.fi.name, Err: errIsDir}
}
func (d *dirFile) Write([]byte) (int, error) {
	return 0, &os.PathError{Op: "write", Path: d.fi.name, Err: errIsDir}
}
func (d *dirFile) Seek(int64, int) (int64, error) { return 0, nil }
func (d *dirFile) Stat() (os.FileInfo, error)     { return d.fi, nil }

// Readdir follows os.File semantics. Listed entries prime the stat
// cache, because x/net/webdav stats every child right after listing.
func (d *dirFile) Readdir(count int) ([]os.FileInfo, error) {
	if !d.loaded {
		entries, err := d.fs.client.List(d.ctx, d.fs.agentID, d.full)
		if err != nil {
			return nil, asPathError("readdir", d.fi.name, err)
		}
		for _, e := range entries {
			if e.Name == "" || e.Name == "." || e.Name == ".." || isMacMetadata(e.Name) {
				continue
			}
			fi := entryInfo(e.Name, e)
			d.fs.cache.put(d.fs.join(d.full, e.Name), fi, nil)
			d.entries = append(d.entries, fi)
		}
		d.loaded = true
	}
	rest := d.entries[d.pos:]
	if count <= 0 {
		d.pos = len(d.entries)
		return rest, nil
	}
	if len(rest) == 0 {
		return nil, io.EOF
	}
	if count > len(rest) {
		count = len(rest)
	}
	d.pos += count
	return rest[:count], nil
}

// readFile serves file content through ranged downloads with a
// read-ahead buffer (see minChunk / maxChunk).
type readFile struct {
	fs     *FS
	ctx    context.Context
	cancel context.CancelFunc
	full   string
	fi     *fileInfo

	mu     sync.Mutex
	pos    int64
	buf    []byte
	bufOff int64
	chunk  int64
	pre    *prefetch
	closed bool
}

type prefetch struct {
	off    int64
	cancel context.CancelFunc
	done   chan struct{}
	data   []byte
	err    error
}

var _ webdav.File = (*readFile)(nil)

func newReadFile(ctx context.Context, fs *FS, full string, fi *fileInfo) *readFile {
	ctx, cancel := context.WithCancel(ctx)
	return &readFile{fs: fs, ctx: ctx, cancel: cancel, full: full, fi: fi}
}

func (f *readFile) Stat() (os.FileInfo, error) { return f.fi, nil }

func (f *readFile) Readdir(int) ([]os.FileInfo, error) {
	return nil, &os.PathError{Op: "readdir", Path: f.fi.name, Err: errNotDir}
}

func (f *readFile) Write([]byte) (int, error) {
	return 0, &os.PathError{Op: "write", Path: f.fi.name, Err: errReadOnlyHandle}
}

func (f *readFile) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	f.dropPrefetch()
	f.cancel()
	f.buf = nil
	return nil
}

func (f *readFile) Seek(offset int64, whence int) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, errClosed
	}
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = f.pos + offset
	case io.SeekEnd:
		abs = f.fi.size + offset
	default:
		return 0, &os.PathError{Op: "seek", Path: f.fi.name, Err: os.ErrInvalid}
	}
	if abs < 0 {
		return 0, &os.PathError{Op: "seek", Path: f.fi.name, Err: os.ErrInvalid}
	}
	f.pos = abs
	return abs, nil
}

func (f *readFile) Read(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, errClosed
	}
	if len(p) == 0 {
		return 0, nil
	}
	if f.pos >= f.fi.size {
		return 0, io.EOF
	}
	if f.pos < f.bufOff || f.pos >= f.bufOff+int64(len(f.buf)) {
		if err := f.fill(int64(len(p))); err != nil {
			return 0, err
		}
	}
	n := copy(p, f.buf[f.pos-f.bufOff:])
	f.pos += int64(n)
	return n, nil
}

// fill loads the chunk starting at f.pos, taking it from the pending
// prefetch when that matches. want is the size of the caller's read.
func (f *readFile) fill(want int64) error {
	sequential := len(f.buf) > 0 && f.pos == f.bufOff+int64(len(f.buf))
	if sequential {
		f.chunk = min(f.chunk*2, maxChunk)
	} else {
		f.chunk = min(max(want, minChunk), maxChunk)
	}

	var data []byte
	var err error
	if pre := f.pre; pre != nil && pre.off == f.pos {
		f.pre = nil
		select {
		case <-pre.done:
		case <-f.ctx.Done():
			pre.cancel()
			return f.ctx.Err()
		}
		pre.cancel()
		data, err = pre.data, pre.err
	} else {
		f.dropPrefetch()
		data, err = f.fs.client.ReadRange(f.ctx, f.fs.agentID, f.full, f.pos, min(f.chunk, f.fi.size-f.pos))
	}
	if err != nil {
		return asPathError("read", f.fi.name, err)
	}
	if len(data) == 0 {
		// The file shrank since it was stat'ed.
		return io.EOF
	}
	f.buf, f.bufOff = data, f.pos

	next := f.bufOff + int64(len(f.buf))
	if sequential && next < f.fi.size {
		f.startPrefetch(next, min(f.chunk*2, maxChunk, f.fi.size-next))
	}
	return nil
}

// startPrefetch downloads the next chunk in the background on its own
// context, so a prefetch made stale by a seek can be cancelled.
func (f *readFile) startPrefetch(off, length int64) {
	ctx, cancel := context.WithCancel(f.ctx)
	pre := &prefetch{off: off, cancel: cancel, done: make(chan struct{})}
	f.pre = pre
	go func() {
		defer close(pre.done)
		pre.data, pre.err = f.fs.client.ReadRange(ctx, f.fs.agentID, f.full, off, length)
	}()
}

// dropPrefetch cancels and forgets the pending prefetch, if any.
func (f *readFile) dropPrefetch() {
	if f.pre != nil {
		f.pre.cancel()
		f.pre = nil
	}
}

// writeFile buffers writes in a temp file and uploads it on Close. The
// temp file is created on first use, and existing content is only
// downloaded when a non-truncating handle actually reads or writes, so
// the O_RDWR open PROPPATCH performs costs nothing.
type writeFile struct {
	fs    *FS
	ctx   context.Context
	full  string
	clean string // share-relative name, for cache invalidation
	name  string
	flag  int
	orig  *fileInfo // nil when the file does not exist yet

	tmp      *os.File
	loaded   bool
	dirty    bool
	closed   bool
	modified time.Time
}

var _ webdav.File = (*writeFile)(nil)

func newWriteFile(ctx context.Context, fs *FS, full, clean string, flag int, orig *fileInfo) *writeFile {
	w := &writeFile{fs: fs, ctx: ctx, full: full, clean: clean, name: path.Base(clean), flag: flag, orig: orig}
	// A new file must be created even when nothing is written (LOCK on
	// an unmapped URL, zero-byte PUT), and O_TRUNC empties an existing
	// one; both need an upload on Close.
	if orig == nil || flag&os.O_TRUNC != 0 {
		w.dirty = true
		w.loaded = true
		w.modified = time.Now()
	}
	return w
}

// ensure creates the temp file and, for a non-truncating handle on an
// existing file, fills it with the current content.
func (w *writeFile) ensure() error {
	if w.closed {
		return errClosed
	}
	if w.tmp == nil {
		tmp, err := os.CreateTemp(w.fs.tempDir, "mmm-dav-*")
		if err != nil {
			return err
		}
		w.tmp = tmp
	}
	if w.loaded {
		return nil
	}
	w.loaded = true
	for off := int64(0); off < w.orig.size; {
		data, err := w.fs.client.ReadRange(w.ctx, w.fs.agentID, w.full, off, min(int64(maxChunk), w.orig.size-off))
		if err != nil {
			return asPathError("read", w.name, err)
		}
		if len(data) == 0 {
			break
		}
		if _, err := w.tmp.Write(data); err != nil {
			return err
		}
		off += int64(len(data))
	}
	_, err := w.tmp.Seek(0, io.SeekStart)
	return err
}

func (w *writeFile) Write(p []byte) (int, error) {
	if err := w.ensure(); err != nil {
		return 0, err
	}
	if w.flag&os.O_APPEND != 0 {
		if _, err := w.tmp.Seek(0, io.SeekEnd); err != nil {
			return 0, err
		}
	}
	w.dirty = true
	w.modified = time.Now()
	return w.tmp.Write(p)
}

func (w *writeFile) Read(p []byte) (int, error) {
	if err := w.ensure(); err != nil {
		return 0, err
	}
	return w.tmp.Read(p)
}

func (w *writeFile) Seek(offset int64, whence int) (int64, error) {
	if err := w.ensure(); err != nil {
		return 0, err
	}
	return w.tmp.Seek(offset, whence)
}

func (w *writeFile) Readdir(int) ([]os.FileInfo, error) {
	return nil, &os.PathError{Op: "readdir", Path: w.name, Err: errNotDir}
}

func (w *writeFile) Stat() (os.FileInfo, error) {
	fi := &fileInfo{name: w.name, mode: 0o600, modTime: w.modified}
	if w.orig != nil {
		fi.mode = w.orig.mode
		if !w.dirty {
			fi.modTime = w.orig.modTime
		}
		if !w.loaded {
			fi.size = w.orig.size
		}
	}
	if w.tmp != nil {
		st, err := w.tmp.Stat()
		if err != nil {
			return nil, err
		}
		fi.size = st.Size()
	}
	return fi, nil
}

// Close uploads the buffered content when anything changed and always
// removes the temp file.
func (w *writeFile) Close() error {
	if w.closed {
		return errClosed
	}
	w.closed = true
	if w.tmp != nil {
		defer func() {
			w.tmp.Close()
			os.Remove(w.tmp.Name())
		}()
	}
	if !w.dirty {
		return nil
	}
	defer w.fs.invalidate(w.clean, false)
	var body io.Reader = http.NoBody
	if w.tmp != nil {
		if _, err := w.tmp.Seek(0, io.SeekStart); err != nil {
			return err
		}
		body = w.tmp
	}
	if err := w.fs.client.Upload(w.ctx, w.fs.agentID, w.full, body); err != nil {
		return asPathError("upload", w.name, err)
	}
	return nil
}
