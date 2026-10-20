package davshare

import (
	"context"
	"errors"
	"mime"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"
)

// statTTL is how long a stat result (positive or "not found") is
// reused. WebDAV clients stat the same paths in bursts (a PROPFIND
// stats every child, Finder probes ._ and .DS_Store files); a short TTL
// absorbs those bursts without serving noticeably stale data. A
// mutation through the share drops the entries it can affect: the
// path, its parent, and for a directory everything below it.
const statTTL = 2 * time.Second

// maxStatCacheEntries bounds the cache; past it expired entries are
// swept, and if that is not enough the cache starts over.
const maxStatCacheEntries = 50000

var errInvalidPath = errors.New("invalid path")
var errIsDir = errors.New("is a directory")
var errNotDir = errors.New("not a directory")

// windowsRoot matches a drive-letter or UNC remote path. Element
// rules are stricter on such roots (see FS.resolve).
var windowsRoot = regexp.MustCompile(`^([A-Za-z]:[\\/]|\\\\)`)

// FS is a webdav.FileSystem backed by one folder on one agent. Every
// name is confined to that folder.
type FS struct {
	client   *AgentClient
	agentID  string
	root     string
	sep      string
	windows  bool
	readOnly bool
	tempDir  string
	cache    statCache
	meta     metaStore // macOS metadata, kept off the agent (meta.go)
}

var _ webdav.FileSystem = (*FS)(nil)

// NewFS returns a FileSystem rooted at remoteRoot on agentID. tempDir
// holds write buffers ("" means os.TempDir()).
func NewFS(client *AgentClient, agentID, remoteRoot string, readOnly bool, tempDir string) *FS {
	fs := &FS{
		client:   client,
		agentID:  agentID,
		readOnly: readOnly,
		tempDir:  tempDir,
		sep:      "/",
	}
	if windowsRoot.MatchString(remoteRoot) {
		fs.windows = true
		fs.sep = `\`
	}
	// Trim trailing separators, but keep "/" and "C:\" intact.
	root := remoteRoot
	for len(root) > 1 && strings.HasSuffix(root, fs.sep) && !(fs.windows && len(root) == 3 && root[1] == ':') {
		root = root[:len(root)-1]
	}
	fs.root = root
	fs.cache.m = newTTLMap[string, statEntry](maxStatCacheEntries)
	return fs
}

// resolve maps a WebDAV name to (agent-side path, cleaned share-relative
// name). The name is cleaned as a rooted path, so ".." can never climb
// above the share root; ".." elements are rejected outright anyway.
// Backslashes are rejected because a Windows agent treats them as
// separators, which would let "..\.." slip past path.Clean. On a
// Windows root ':' is rejected too (drive letters, alternate streams).
func (fs *FS) resolve(name string) (string, string, error) {
	if strings.ContainsAny(name, "\x00\\") {
		return "", "", errInvalidPath
	}
	for _, el := range strings.Split(name, "/") {
		if el == ".." {
			return "", "", errInvalidPath
		}
	}
	clean := path.Clean("/" + name)
	if clean == "/" {
		return fs.root, clean, nil
	}
	rel := clean[1:]
	if fs.windows {
		if strings.ContainsRune(rel, ':') {
			return "", "", errInvalidPath
		}
		rel = strings.ReplaceAll(rel, "/", `\`)
	}
	return fs.join(fs.root, rel), clean, nil
}

func (fs *FS) join(dir, name string) string {
	if strings.HasSuffix(dir, fs.sep) {
		return dir + name
	}
	return dir + fs.sep + name
}

// invalidate drops the cached stats a mutation of the share-relative
// clean name can change: the name itself and its parent, plus every
// path below it when tree is set (a directory delete or rename).
func (fs *FS) invalidate(clean string, tree bool) {
	full, _, err := fs.resolve(clean)
	if err != nil {
		return
	}
	parent, _, _ := fs.resolve(path.Dir(clean))
	fs.cache.invalidate(full, parent, tree, fs.join(full, ""))
}

// Stat implements webdav.FileSystem.
func (fs *FS) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	fi, err := fs.stat(ctx, name)
	if err != nil {
		return nil, err
	}
	return fi, nil
}

func (fs *FS) stat(ctx context.Context, name string) (*fileInfo, error) {
	full, clean, err := fs.resolve(name)
	if err != nil {
		return nil, &os.PathError{Op: "stat", Path: name, Err: err}
	}
	if isMacMetadata(clean) {
		return fs.meta.stat(clean)
	}
	if fi, err, ok := fs.cache.get(full); ok {
		return fi, err
	}
	e, err := fs.client.Stat(ctx, fs.agentID, full)
	if err != nil {
		perr := asPathError("stat", name, err)
		if os.IsNotExist(perr) {
			fs.cache.put(full, nil, perr)
		}
		return nil, perr
	}
	fi := entryInfo(path.Base(clean), e)
	fs.cache.put(full, fi, nil)
	return fi, nil
}

// Mkdir implements webdav.FileSystem.
func (fs *FS) Mkdir(ctx context.Context, name string, perm os.FileMode) error {
	if fs.readOnly {
		return &os.PathError{Op: "mkdir", Path: name, Err: os.ErrPermission}
	}
	full, clean, err := fs.resolve(name)
	if err != nil {
		return &os.PathError{Op: "mkdir", Path: name, Err: err}
	}
	if clean == "/" {
		return &os.PathError{Op: "mkdir", Path: name, Err: os.ErrExist}
	}
	if isMacMetadata(clean) {
		if err := fs.meta.mkdir(clean); err != nil {
			return &os.PathError{Op: "mkdir", Path: name, Err: err}
		}
		return nil
	}
	defer fs.invalidate(clean, false)
	if err := fs.client.Mkdir(ctx, fs.agentID, full); err != nil {
		return asPathError("mkdir", name, err)
	}
	return nil
}

// RemoveAll implements webdav.FileSystem. The share root itself can
// not be removed.
func (fs *FS) RemoveAll(ctx context.Context, name string) error {
	if fs.readOnly {
		return &os.PathError{Op: "remove", Path: name, Err: os.ErrPermission}
	}
	full, clean, err := fs.resolve(name)
	if err != nil {
		return &os.PathError{Op: "remove", Path: name, Err: err}
	}
	if clean == "/" {
		return &os.PathError{Op: "remove", Path: name, Err: os.ErrPermission}
	}
	// Metadata goes with the real folder it belongs to.
	fs.meta.removeAll(clean)
	if isMacMetadata(clean) {
		return nil
	}
	defer fs.invalidate(clean, true)
	if err := fs.client.Delete(ctx, fs.agentID, full, true); err != nil {
		perr := asPathError("remove", name, err)
		if os.IsNotExist(perr) {
			return nil
		}
		return perr
	}
	return nil
}

// Rename implements webdav.FileSystem.
func (fs *FS) Rename(ctx context.Context, oldName, newName string) error {
	if fs.readOnly {
		return &os.PathError{Op: "rename", Path: oldName, Err: os.ErrPermission}
	}
	oldFull, oldClean, err := fs.resolve(oldName)
	if err != nil {
		return &os.PathError{Op: "rename", Path: oldName, Err: err}
	}
	newFull, newClean, err := fs.resolve(newName)
	if err != nil {
		return &os.PathError{Op: "rename", Path: newName, Err: err}
	}
	if oldClean == "/" || newClean == "/" || isMacMetadata(oldClean) != isMacMetadata(newClean) {
		return &os.PathError{Op: "rename", Path: oldName, Err: os.ErrPermission}
	}
	if isMacMetadata(oldClean) {
		if !fs.meta.rename(oldClean, newClean) {
			return &os.PathError{Op: "rename", Path: oldName, Err: os.ErrNotExist}
		}
		return nil
	}
	defer func() {
		fs.invalidate(oldClean, true)
		fs.invalidate(newClean, true)
	}()
	if err := fs.client.Rename(ctx, fs.agentID, oldFull, newFull); err != nil {
		return asPathError("rename", oldName, err)
	}
	// Metadata goes with the real folder it belongs to.
	fs.meta.rename(oldClean, newClean)
	return nil
}

// OpenFile implements webdav.FileSystem. Opening never transfers file
// content: x/net/webdav opens every resource it reports properties
// for, so reads are fetched lazily and writes are buffered to a temp
// file and uploaded on Close.
func (fs *FS) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (webdav.File, error) {
	full, clean, err := fs.resolve(name)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: name, Err: err}
	}
	write := flag&(os.O_WRONLY|os.O_RDWR|os.O_APPEND|os.O_CREATE|os.O_TRUNC) != 0
	if write && fs.readOnly {
		return nil, &os.PathError{Op: "open", Path: name, Err: os.ErrPermission}
	}
	if isMacMetadata(clean) {
		return fs.meta.open(clean, flag)
	}
	fi, statErr := fs.stat(ctx, name)
	if statErr != nil && !os.IsNotExist(statErr) {
		return nil, statErr
	}
	exists := statErr == nil

	if !write {
		if !exists {
			return nil, statErr
		}
		if fi.IsDir() {
			return &dirFile{fs: fs, ctx: ctx, full: full, fi: fi}, nil
		}
		return newReadFile(ctx, fs, full, fi), nil
	}

	if exists && fi.IsDir() {
		// PROPPATCH opens collections O_RDWR; anything that would
		// write file content into a directory is refused.
		if flag&(os.O_WRONLY|os.O_TRUNC|os.O_APPEND) != 0 || flag&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL {
			return nil, &os.PathError{Op: "open", Path: name, Err: errIsDir}
		}
		return &dirFile{fs: fs, ctx: ctx, full: full, fi: fi}, nil
	}
	if exists && flag&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL {
		return nil, &os.PathError{Op: "open", Path: name, Err: os.ErrExist}
	}
	if !exists {
		if flag&os.O_CREATE == 0 {
			return nil, statErr
		}
		// The agent's upload creates missing parents; WebDAV wants a
		// 409 instead, so check the parent ourselves.
		parent, err := fs.stat(ctx, path.Dir(clean))
		if err != nil {
			return nil, err
		}
		if !parent.IsDir() {
			return nil, &os.PathError{Op: "open", Path: name, Err: os.ErrNotExist}
		}
	}
	return newWriteFile(ctx, fs, full, clean, flag, fi), nil
}

// fileInfo is the os.FileInfo for an agent entry.
type fileInfo struct {
	name    string
	size    int64
	mode    os.FileMode
	modTime time.Time
	dir     bool
}

func entryInfo(name string, e FileEntry) *fileInfo {
	fi := &fileInfo{name: name, size: e.Size, mode: parseMode(e.Mode), dir: e.IsDir}
	if t, err := time.Parse(time.RFC3339Nano, e.ModTime); err == nil {
		fi.modTime = t
	}
	if fi.dir {
		fi.mode |= os.ModeDir
	}
	return fi
}

func (fi *fileInfo) Name() string       { return fi.name }
func (fi *fileInfo) Size() int64        { return fi.size }
func (fi *fileInfo) Mode() os.FileMode  { return fi.mode }
func (fi *fileInfo) ModTime() time.Time { return fi.modTime }
func (fi *fileInfo) IsDir() bool        { return fi.dir }
func (fi *fileInfo) Sys() any           { return nil }

// ContentType implements webdav.ContentTyper. Without it x/net/webdav
// opens and reads the first 512 bytes of every extensionless file in a
// PROPFIND listing, which over the mesh means one download per file.
func (fi *fileInfo) ContentType(ctx context.Context) (string, error) {
	return contentTypeFor(fi.name), nil
}

func contentTypeFor(name string) string {
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// statCache is a small TTL cache of stat results keyed by agent path.
type statCache struct {
	mu sync.Mutex
	m  ttlMap[string, statEntry]
}

type statEntry struct {
	fi  *fileInfo
	err error
}

func (c *statCache) get(key string) (*fileInfo, error, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, _, ok := c.m.get(key, time.Now())
	return e.fi, e.err, ok
}

func (c *statCache) put(key string, fi *fileInfo, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	c.m.put(key, statEntry{fi: fi, err: err}, now.Add(statTTL), now)
}

// invalidate drops full and parent, and with tree every key under
// prefix (full followed by the path separator).
func (c *statCache) invalidate(full, parent string, tree bool, prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m.delete(full)
	c.m.delete(parent)
	if tree {
		c.m.deleteFunc(func(k string) bool { return strings.HasPrefix(k, prefix) })
	}
}
