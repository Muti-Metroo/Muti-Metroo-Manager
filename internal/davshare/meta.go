package davshare

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"
)

// macOS metadata (see isMacMetadata) lives in memory instead of on the
// agent. It has to behave like real files for the session: macOS keeps
// extended attributes in "._name" files and updates them by locking,
// reading, and rewriting them, so a server that refuses or drops them
// makes copies fail ("could not copy extended attributes", or 423 on
// the rewrite of a file that vanished). Keeping them in memory gives
// macOS a normal server while nothing reaches the target; they are gone
// when Manager restarts, as they would be on a server without extended
// attribute support.

// macMetadataNames are the files and folders macOS writes next to user
// content on a network volume: Finder state (.DS_Store), Spotlight and
// fsevents stores, trash, and "._name" AppleDouble files.
var macMetadataNames = map[string]bool{
	".DS_Store":             true,
	".Spotlight-V100":       true,
	".TemporaryItems":       true,
	".Trashes":              true,
	".fseventsd":            true,
	".metadata_never_index": true,
	".apdisk":               true,
}

// isMacMetadata reports whether the share-relative clean name is, or is
// inside, macOS metadata.
func isMacMetadata(clean string) bool {
	for _, el := range strings.Split(clean, "/") {
		if strings.HasPrefix(el, "._") || macMetadataNames[el] {
			return true
		}
	}
	return false
}

// metaFileLimit caps one metadata file. AppleDouble files carry extended
// attributes and resource forks; a few KB is typical.
const metaFileLimit = 4 << 20

// metaTotalLimit caps a share's metadata; past it the oldest entries are
// dropped, which macOS sees as attributes it can rewrite.
const metaTotalLimit = 32 << 20

var errMetaTooLarge = errors.New("metadata file too large")

type metaEntry struct {
	dir     bool
	data    []byte
	modTime time.Time
	seq     uint64 // store order, for eviction
}

// metaStore holds one share's metadata, keyed by share-relative clean
// name.
type metaStore struct {
	mu    sync.Mutex
	m     map[string]*metaEntry
	total int
	seq   uint64
}

func (s *metaStore) stat(clean string) (*fileInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.m[clean]
	if e == nil {
		return nil, &os.PathError{Op: "stat", Path: clean, Err: os.ErrNotExist}
	}
	return metaInfo(clean, e), nil
}

func metaInfo(clean string, e *metaEntry) *fileInfo {
	fi := &fileInfo{name: path.Base(clean), size: int64(len(e.data)), mode: 0o644, modTime: e.modTime, dir: e.dir}
	if e.dir {
		fi.mode = os.ModeDir | 0o755
	}
	return fi
}

// mkdir records a metadata folder. Like metadata files, it is created
// without checking its parent: macOS only creates them next to content
// that exists.
func (s *metaStore) mkdir(clean string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m[clean] != nil {
		return os.ErrExist
	}
	s.put(clean, &metaEntry{dir: true, modTime: time.Now()})
	return nil
}

// put stores e under clean and evicts the oldest files while the share
// is over metaTotalLimit. Callers hold s.mu.
func (s *metaStore) put(clean string, e *metaEntry) {
	if s.m == nil {
		s.m = make(map[string]*metaEntry)
	}
	if old := s.m[clean]; old != nil {
		s.total -= len(old.data)
	}
	s.seq++
	e.seq = s.seq
	s.m[clean] = e
	s.total += len(e.data)
	for s.total > metaTotalLimit {
		var oldest string
		for k, v := range s.m {
			if !v.dir && k != clean && (oldest == "" || v.seq < s.m[oldest].seq) {
				oldest = k
			}
		}
		if oldest == "" {
			return
		}
		s.total -= len(s.m[oldest].data)
		delete(s.m, oldest)
	}
}

// removeAll deletes clean and everything below it.
func (s *metaStore) removeAll(clean string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.m {
		if under(k, clean) {
			s.total -= len(e.data)
			delete(s.m, k)
		}
	}
}

// rename moves clean and everything below it to dst, replacing whatever
// was at dst. It also carries the metadata of a real folder that was
// renamed, so moved reports whether anything was there.
func (s *metaStore) rename(clean, dst string) (moved bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.m {
		if under(k, dst) {
			s.total -= len(e.data)
			delete(s.m, k)
		}
	}
	for k, e := range s.m {
		if under(k, clean) {
			delete(s.m, k)
			s.m[dst+strings.TrimPrefix(k, clean)] = e
			moved = true
		}
	}
	return moved
}

// under reports whether k is name or below it.
func under(k, name string) bool {
	return k == name || strings.HasPrefix(k, name+"/")
}

// open returns a handle on a metadata file. Writes go to a private copy
// that is stored on Close.
func (s *metaStore) open(clean string, flag int) (webdav.File, error) {
	s.mu.Lock()
	e := s.m[clean]
	s.mu.Unlock()
	if e != nil && e.dir {
		return &metaDir{fi: metaInfo(clean, e)}, nil
	}
	write := flag&(os.O_WRONLY|os.O_RDWR|os.O_APPEND|os.O_CREATE|os.O_TRUNC) != 0
	switch {
	case e == nil && !write:
		return nil, &os.PathError{Op: "open", Path: clean, Err: os.ErrNotExist}
	case e != nil && flag&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL:
		return nil, &os.PathError{Op: "open", Path: clean, Err: os.ErrExist}
	}
	f := &metaFile{store: s, clean: clean, flag: flag}
	if e == nil || flag&os.O_TRUNC != 0 {
		f.dirty, f.owned, f.modTime = true, true, time.Now()
	} else {
		f.data, f.modTime = e.data, e.modTime
	}
	return f, nil
}

// metaFile is an open metadata file. data is shared with the store
// until the first write copies it (owned).
type metaFile struct {
	store   *metaStore
	clean   string
	flag    int
	data    []byte
	pos     int64
	owned   bool
	dirty   bool
	modTime time.Time
}

func (f *metaFile) Read(p []byte) (int, error) {
	if f.pos >= int64(len(f.data)) {
		return 0, io.EOF
	}
	n := copy(p, f.data[f.pos:])
	f.pos += int64(n)
	return n, nil
}

func (f *metaFile) Write(p []byte) (int, error) {
	if f.flag&os.O_APPEND != 0 {
		f.pos = int64(len(f.data))
	}
	end := f.pos + int64(len(p))
	if end > metaFileLimit {
		return 0, errMetaTooLarge
	}
	if !f.owned {
		f.data, f.owned = bytes.Clone(f.data), true
	}
	if end > int64(len(f.data)) {
		f.data = append(f.data, make([]byte, end-int64(len(f.data)))...)
	}
	copy(f.data[f.pos:], p)
	f.pos = end
	f.dirty = true
	f.modTime = time.Now()
	return len(p), nil
}

func (f *metaFile) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekCurrent:
		offset += f.pos
	case io.SeekEnd:
		offset += int64(len(f.data))
	}
	if offset < 0 {
		return 0, errInvalidPath
	}
	f.pos = offset
	return offset, nil
}

func (f *metaFile) Readdir(int) ([]os.FileInfo, error) { return nil, errNotDir }

func (f *metaFile) Stat() (os.FileInfo, error) {
	return metaInfo(f.clean, &metaEntry{data: f.data, modTime: f.modTime}), nil
}

func (f *metaFile) Close() error {
	if !f.dirty {
		return nil
	}
	f.dirty = false
	f.store.mu.Lock()
	defer f.store.mu.Unlock()
	f.store.put(f.clean, &metaEntry{data: f.data, modTime: f.modTime})
	f.owned = false
	return nil
}

// metaDir is an open metadata folder. Its content is not listed, like
// all metadata.
type metaDir struct{ fi *fileInfo }

func (d *metaDir) Close() error                   { return nil }
func (d *metaDir) Read([]byte) (int, error)       { return 0, errIsDir }
func (d *metaDir) Write([]byte) (int, error)      { return 0, errIsDir }
func (d *metaDir) Seek(int64, int) (int64, error) { return 0, nil }
func (d *metaDir) Readdir(count int) ([]os.FileInfo, error) {
	if count > 0 {
		return nil, io.EOF
	}
	return nil, nil
}
func (d *metaDir) Stat() (os.FileInfo, error) { return d.fi, nil }
