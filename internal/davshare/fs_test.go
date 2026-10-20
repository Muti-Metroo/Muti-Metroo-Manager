package davshare

import (
	"bytes"
	"context"
	"io"
	"math/rand"
	"os"
	"path"
	"strconv"
	"strings"
	"testing"
)

func newTestFS(t *testing.T, fa *fakeAgent, readOnly bool) (*FS, string) {
	t.Helper()
	tmp := t.TempDir()
	return NewFS(fa.client(), fakeAgentID, "/srv/share", readOnly, tmp), tmp
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.New(rand.NewSource(int64(n))).Read(b)
	return b
}

// assertConfined fails when the FS ever sent the agent a path that is
// not a clean path under the share root.
func assertConfined(t *testing.T, fa *fakeAgent) {
	t.Helper()
	for _, p := range fa.seenPaths() {
		if path.Clean(p) != p || (p != "/srv/share" && !strings.HasPrefix(p, "/srv/share/")) {
			t.Errorf("agent saw path outside the share root: %q", p)
		}
	}
}

func TestResolveConfinement(t *testing.T) {
	fs := NewFS(nil, fakeAgentID, "/srv/share/", false, "")
	ok := map[string]string{
		"":                "/srv/share",
		"/":               "/srv/share",
		"/a/b":            "/srv/share/a/b",
		"a//b/":           "/srv/share/a/b",
		"/./a/.":          "/srv/share/a",
		"/with space":     "/srv/share/with space",
		"/colon:name":     "/srv/share/colon:name",
		"/unicode-\u00e9": "/srv/share/unicode-\u00e9",
	}
	for in, want := range ok {
		got, _, err := fs.resolve(in)
		if err != nil || got != want {
			t.Errorf("resolve(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"/..", "/../etc", "/a/../../etc", "/a\\..\\..\\etc", "/nul\x00byte", ".."} {
		if got, _, err := fs.resolve(bad); err == nil {
			t.Errorf("resolve(%q) = %q, want error", bad, got)
		}
	}

	root := NewFS(nil, fakeAgentID, "/", false, "")
	if got, _, _ := root.resolve("/etc"); got != "/etc" {
		t.Errorf("root share resolve = %q, want /etc", got)
	}

	win := NewFS(nil, fakeAgentID, `C:\Data\`, false, "")
	if got, _, err := win.resolve("/a/b.txt"); err != nil || got != `C:\Data\a\b.txt` {
		t.Errorf("windows resolve = %q, %v", got, err)
	}
	if _, _, err := win.resolve("/C:/Windows"); err == nil {
		t.Error("windows resolve accepted a drive-letter element")
	}
	drive := NewFS(nil, fakeAgentID, `D:\`, false, "")
	if got, _, _ := drive.resolve("/x"); got != `D:\x` {
		t.Errorf("drive root resolve = %q, want D:\\x", got)
	}
}

func TestStatErrorMapping(t *testing.T) {
	fa := newFakeAgent(t)
	fs, _ := newTestFS(t, fa, false)
	ctx := context.Background()

	if _, err := fs.Stat(ctx, "/missing"); !os.IsNotExist(err) {
		t.Errorf("missing: err = %v, want os.IsNotExist", err)
	}

	// A share rooted outside allowed_paths surfaces as a permission error.
	outside := NewFS(fa.client(), fakeAgentID, "/srv/secret", false, "")
	if _, err := outside.Stat(ctx, "/"); !os.IsPermission(err) {
		t.Errorf("not_allowed: err = %v, want os.IsPermission", err)
	}

	// Without the error_code the message still classifies.
	ae := &AgentError{Msg: "path not found: /x"}
	if !os.IsNotExist(asPathError("stat", "/x", ae)) {
		t.Error("message-only not found was not mapped to ErrNotExist")
	}
	if !os.IsExist(asPathError("mkdir", "/x", &AgentError{Code: "already_exists"})) {
		t.Error("already_exists was not mapped to ErrExist")
	}
}

func TestStatCache(t *testing.T) {
	fa := newFakeAgent(t)
	fa.write("/srv/share/a.txt", []byte("hello"))
	fs, _ := newTestFS(t, fa, false)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		fi, err := fs.Stat(ctx, "/a.txt")
		if err != nil || fi.Size() != 5 || fi.IsDir() {
			t.Fatalf("stat = %+v, %v", fi, err)
		}
	}
	if n := fa.count("browse:stat"); n != 1 {
		t.Errorf("stat calls = %d, want 1 (cached)", n)
	}
	// Negative results are cached too.
	fs.Stat(ctx, "/missing.txt")
	fs.Stat(ctx, "/missing.txt")
	if n := fa.count("browse:stat"); n != 2 {
		t.Errorf("stat calls = %d, want 2 after negative cache", n)
	}
	// A mutation drops only the paths it can affect: the negative
	// entry for the new directory goes, an unrelated file stays.
	fs.Stat(ctx, "/d")
	if n := fa.count("browse:stat"); n != 3 {
		t.Fatalf("stat calls = %d, want 3", n)
	}
	if err := fs.Mkdir(ctx, "/d", 0o755); err != nil {
		t.Fatal(err)
	}
	fs.Stat(ctx, "/a.txt")
	if n := fa.count("browse:stat"); n != 3 {
		t.Errorf("stat calls = %d, want 3 (unrelated entry kept)", n)
	}
	if fi, err := fs.Stat(ctx, "/d"); err != nil || !fi.IsDir() {
		t.Errorf("stat new dir = %v, %v", fi, err)
	}
	if n := fa.count("browse:stat"); n != 4 {
		t.Errorf("stat calls = %d, want 4 (new dir refetched)", n)
	}

	// Removing a directory drops the cached entries below it.
	fa.write("/srv/share/d/x.txt", []byte("x"))
	if _, err := fs.Stat(ctx, "/d/x.txt"); err != nil {
		t.Fatal(err)
	}
	if err := fs.RemoveAll(ctx, "/d"); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(ctx, "/d/x.txt"); !os.IsNotExist(err) {
		t.Errorf("stat below removed dir = %v, want not exist", err)
	}

	// A rename drops both trees.
	if _, err := fs.Stat(ctx, "/b.txt"); !os.IsNotExist(err) {
		t.Fatalf("stat b.txt = %v", err)
	}
	if err := fs.Rename(ctx, "/a.txt", "/b.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(ctx, "/a.txt"); !os.IsNotExist(err) {
		t.Errorf("stat renamed source = %v, want not exist", err)
	}
	if _, err := fs.Stat(ctx, "/b.txt"); err != nil {
		t.Errorf("stat rename target = %v", err)
	}
}

func TestReaddirPrimesStatCache(t *testing.T) {
	fa := newFakeAgent(t)
	for i := 0; i < 7; i++ {
		fa.write("/srv/share/dir/f"+string(rune('a'+i)), []byte("x"))
	}
	fs, _ := newTestFS(t, fa, false)
	ctx := context.Background()

	f, err := fs.OpenFile(ctx, "/dir", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	fis, err := f.Readdir(0)
	f.Close()
	if err != nil || len(fis) != 7 {
		t.Fatalf("readdir = %d entries, %v", len(fis), err)
	}
	fa.reset()
	for _, fi := range fis {
		if _, err := fs.Stat(ctx, "/dir/"+fi.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if n := fa.count("browse:stat"); n != 0 {
		t.Errorf("stat calls after readdir = %d, want 0", n)
	}
	// os.File-style paging.
	f, _ = fs.OpenFile(ctx, "/dir", os.O_RDONLY, 0)
	defer f.Close()
	first, _ := f.Readdir(5)
	second, _ := f.Readdir(5)
	_, err = f.Readdir(5)
	if len(first) != 5 || len(second) != 2 || err != io.EOF {
		t.Errorf("paging = %d, %d, %v", len(first), len(second), err)
	}
}

func TestListPaginates(t *testing.T) {
	fa := newFakeAgent(t)
	n := maxListPage + 3
	for i := 0; i < n; i++ {
		if err := os.WriteFile(fa.local("/srv/share/f"+strconv.Itoa(i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := fa.client().List(context.Background(), fakeAgentID, "/srv/share")
	if err != nil || len(entries) != n {
		t.Fatalf("list = %d entries, %v; want %d", len(entries), err, n)
	}
	if c := fa.count("browse:list"); c != 2 {
		t.Errorf("list calls = %d, want 2", c)
	}
}

func TestRangedReads(t *testing.T) {
	fa := newFakeAgent(t)
	data := randomBytes(10<<20 + 123)
	fa.write("/srv/share/big.bin", data)
	fs, _ := newTestFS(t, fa, false)
	ctx := context.Background()

	f, err := fs.OpenFile(ctx, "/big.bin", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Opening transfers nothing.
	if n := fa.count("download"); n != 0 {
		t.Fatalf("downloads after open = %d, want 0", n)
	}

	// A small read in the middle fetches one minChunk window there.
	off := int64(5 << 20)
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4096)
	if _, err := io.ReadFull(f, buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, data[off:off+4096]) {
		t.Fatal("mid-file read returned wrong bytes")
	}
	if r := fa.ranges(); len(r) != 1 || r[0] != (rangeReq{off, minChunk}) {
		t.Fatalf("ranges = %+v, want one {%d %d}", r, off, minChunk)
	}
	// Another read inside the buffered window is served locally.
	f.Seek(off+10000, io.SeekStart)
	io.ReadFull(f, buf)
	if !bytes.Equal(buf, data[off+10000:off+10000+4096]) {
		t.Fatal("buffered read returned wrong bytes")
	}
	if n := fa.count("download"); n != 1 {
		t.Fatalf("downloads = %d, want 1", n)
	}

	// A large non-sequential read fetches what was asked for in one go.
	fa.reset()
	big := make([]byte, 300<<10)
	f.Seek(1<<20, io.SeekStart)
	if _, err := io.ReadFull(f, big); err != nil || !bytes.Equal(big, data[1<<20:1<<20+len(big)]) {
		t.Fatalf("large read: %v", err)
	}
	if r := fa.ranges(); len(r) != 1 || r[0] != (rangeReq{1 << 20, int64(len(big))}) {
		t.Fatalf("ranges = %+v, want one {%d %d}", r, 1<<20, len(big))
	}

	// Seek relative to the end, read the tail.
	if pos, err := f.Seek(-10, io.SeekEnd); err != nil || pos != int64(len(data))-10 {
		t.Fatalf("seek end = %d, %v", pos, err)
	}
	tail, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(tail, data[len(data)-10:]) {
		t.Fatalf("tail = %d bytes, %v", len(tail), err)
	}
	if _, err := f.Seek(-1, io.SeekStart); err == nil {
		t.Error("negative seek accepted")
	}
	f.Close()

	// A full sequential read is correct and grows the window.
	fa.reset()
	f, _ = fs.OpenFile(ctx, "/big.bin", os.O_RDONLY, 0)
	all, err := io.ReadAll(f)
	f.Close()
	if err != nil || !bytes.Equal(all, data) {
		t.Fatalf("sequential read: %d bytes, %v", len(all), err)
	}
	rs := fa.ranges()
	for _, r := range rs {
		if r.length <= 0 || r.length > maxChunk {
			t.Errorf("range length %d outside (0, %d]", r.length, maxChunk)
		}
	}
	// Windows doubling from 64 KiB to 4 MiB (64K..2M sum to ~4 MiB),
	// then 4 MiB each, cover 10 MiB + tail in at most 9 requests.
	if len(rs) > 9 {
		t.Errorf("sequential read used %d requests, want <= 9: %+v", len(rs), rs)
	}
	assertConfined(t, fa)
}

func TestStalePrefetchDropped(t *testing.T) {
	fa := newFakeAgent(t)
	data := randomBytes(4<<20 + 7)
	fa.write("/srv/share/big.bin", data)
	fs, _ := newTestFS(t, fa, false)
	f, err := fs.OpenFile(context.Background(), "/big.bin", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rf := f.(*readFile)
	// Two sequential windows start a prefetch of the third.
	buf := make([]byte, minChunk)
	for i := 0; i < 2; i++ {
		if _, err := io.ReadFull(f, buf); err != nil {
			t.Fatal(err)
		}
	}
	rf.mu.Lock()
	pre := rf.pre
	rf.mu.Unlock()
	if pre == nil {
		t.Fatal("no prefetch after a sequential read")
	}
	// A seek elsewhere drops it and reads the right bytes.
	off := int64(3 << 20)
	f.Seek(off, io.SeekStart)
	small := make([]byte, 100)
	if _, err := io.ReadFull(f, small); err != nil || !bytes.Equal(small, data[off:off+100]) {
		t.Fatalf("read after seek: %v", err)
	}
	rf.mu.Lock()
	stale := rf.pre == pre
	rf.mu.Unlock()
	if stale {
		t.Error("stale prefetch kept after a seek")
	}
	<-pre.done
}

func TestWriteOnClose(t *testing.T) {
	fa := newFakeAgent(t)
	fs, tmp := newTestFS(t, fa, false)
	ctx := context.Background()

	f, err := fs.OpenFile(ctx, "/new.txt", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("hello "))
	f.Write([]byte("world"))
	if fi, _ := f.Stat(); fi.Size() != 11 {
		t.Errorf("stat size before close = %d, want 11", fi.Size())
	}
	if n := fa.count("upload"); n != 0 {
		t.Fatalf("uploaded before close: %d", n)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if got, _ := fa.read("/srv/share/new.txt"); string(got) != "hello world" {
		t.Errorf("uploaded content = %q", got)
	}
	if ents, _ := os.ReadDir(tmp); len(ents) != 0 {
		t.Errorf("temp files left behind: %d", len(ents))
	}

	// The upload is visible to the next stat (cache cleared on close).
	if fi, err := fs.Stat(ctx, "/new.txt"); err != nil || fi.Size() != 11 {
		t.Errorf("stat after upload = %v, %v", fi, err)
	}

	// Zero-byte create still uploads.
	f, _ = fs.OpenFile(ctx, "/empty", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if got, err := fa.read("/srv/share/empty"); err != nil || len(got) != 0 {
		t.Errorf("empty file = %q, %v", got, err)
	}

	// O_EXCL on an existing file.
	if _, err := fs.OpenFile(ctx, "/new.txt", os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o666); !os.IsExist(err) {
		t.Errorf("O_EXCL on existing: err = %v, want os.IsExist", err)
	}
	// No O_CREATE on a missing file.
	if _, err := fs.OpenFile(ctx, "/nope", os.O_RDWR, 0); !os.IsNotExist(err) {
		t.Errorf("open missing without O_CREATE: err = %v", err)
	}
	// Missing parent maps to not-exist (webdav answers 409).
	if _, err := fs.OpenFile(ctx, "/no/such/dir/x", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666); !os.IsNotExist(err) {
		t.Errorf("missing parent: err = %v, want os.IsNotExist", err)
	}
	// Writing file content onto a directory is refused.
	fa.write("/srv/share/sub/x", nil)
	if _, err := fs.OpenFile(ctx, "/sub", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666); err == nil {
		t.Error("O_TRUNC on a directory succeeded")
	}

	// A non-truncating RDWR handle (PROPPATCH) that writes nothing
	// neither downloads nor uploads.
	fa.reset()
	f, err = fs.OpenFile(ctx, "/new.txt", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if fa.count("upload") != 0 || fa.count("download") != 0 {
		t.Errorf("idle RDWR handle transferred: up=%d down=%d", fa.count("upload"), fa.count("download"))
	}

	// A non-truncating handle that writes keeps the existing content.
	f, _ = fs.OpenFile(ctx, "/new.txt", os.O_RDWR, 0)
	f.Seek(6, io.SeekStart)
	f.Write([]byte("WORLD"))
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if got, _ := fa.read("/srv/share/new.txt"); string(got) != "hello WORLD" {
		t.Errorf("patched content = %q", got)
	}
	assertConfined(t, fa)
}

func TestUploadErrorSurfacesOnClose(t *testing.T) {
	fa := newFakeAgent(t)
	fa.allowed = "/srv/share/ro-sub-only" // root stat passes below, upload is refused
	fs := NewFS(fa.client(), fakeAgentID, "/srv/share/ro-sub-only", false, t.TempDir())
	os.MkdirAll(fa.local("/srv/share/ro-sub-only"), 0o755)
	f, err := fs.OpenFile(context.Background(), "/x", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("data"))
	fa.allowed = "/elsewhere"
	if err := f.Close(); !os.IsPermission(err) {
		t.Errorf("close err = %v, want os.IsPermission", err)
	}
}

func TestMkdirRenameRemove(t *testing.T) {
	fa := newFakeAgent(t)
	fs, _ := newTestFS(t, fa, false)
	ctx := context.Background()

	if err := fs.Mkdir(ctx, "/d", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := fs.Mkdir(ctx, "/d", 0o755); !os.IsExist(err) {
		t.Errorf("mkdir existing: err = %v, want os.IsExist", err)
	}
	if err := fs.Mkdir(ctx, "/x/y", 0o755); !os.IsNotExist(err) {
		t.Errorf("mkdir missing parent: err = %v, want os.IsNotExist", err)
	}
	if err := fs.Mkdir(ctx, "/", 0o755); !os.IsExist(err) {
		t.Errorf("mkdir root: err = %v", err)
	}

	fa.write("/srv/share/d/f.txt", []byte("1"))
	fa.write("/srv/share/other.txt", []byte("2"))
	if err := fs.Rename(ctx, "/d", "/e"); err != nil {
		t.Fatal(err)
	}
	if _, err := fa.read("/srv/share/e/f.txt"); err != nil {
		t.Errorf("renamed file missing: %v", err)
	}
	if err := fs.Rename(ctx, "/other.txt", "/e"); !os.IsExist(err) {
		t.Errorf("rename onto existing: err = %v, want os.IsExist", err)
	}
	if err := fs.Rename(ctx, "/", "/z"); !os.IsPermission(err) {
		t.Errorf("rename root: err = %v", err)
	}
	if err := fs.Rename(ctx, "/e", "/../escape"); err == nil {
		t.Error("rename out of the share accepted")
	}

	if err := fs.RemoveAll(ctx, "/e"); err != nil {
		t.Fatal(err)
	}
	if _, err := fa.read("/srv/share/e/f.txt"); err == nil {
		t.Error("recursive delete left files")
	}
	if err := fs.RemoveAll(ctx, "/e"); err != nil {
		t.Errorf("removing a missing path should succeed, got %v", err)
	}
	if err := fs.RemoveAll(ctx, "/"); !os.IsPermission(err) {
		t.Errorf("remove root: err = %v", err)
	}
	assertConfined(t, fa)
}

// macOS metadata never reaches the agent: it lives in memory, where it
// behaves like ordinary files, and pre-existing copies on the agent are
// neither visible nor touched.
func TestMacMetadataInMemory(t *testing.T) {
	fa := newFakeAgent(t)
	fa.write("/srv/share/a.txt", []byte("hello"))
	fa.write("/srv/share/._a.txt", []byte("appledouble on the agent"))
	fa.write("/srv/share/.DS_Store", []byte("finder"))
	fs, _ := newTestFS(t, fa, false)
	ctx := context.Background()

	readAll := func(name string) string {
		t.Helper()
		f, err := fs.OpenFile(ctx, name, os.O_RDONLY, 0)
		if err != nil {
			t.Fatalf("open %q: %v", name, err)
		}
		defer f.Close()
		b, _ := io.ReadAll(f)
		return string(b)
	}
	writeAll := func(name string, flag int, data string) {
		t.Helper()
		f, err := fs.OpenFile(ctx, name, flag, 0o644)
		if err != nil {
			t.Fatalf("open %q for write: %v", name, err)
		}
		if _, err := f.Write([]byte(data)); err != nil {
			t.Fatalf("write %q: %v", name, err)
		}
		if err := f.Close(); err != nil {
			t.Fatalf("close %q: %v", name, err)
		}
	}

	// The agent's copies are invisible; the share starts with none.
	for _, name := range []string{"/._a.txt", "/.DS_Store"} {
		if _, err := fs.Stat(ctx, name); !os.IsNotExist(err) {
			t.Errorf("Stat(%q) = %v, want not exist", name, err)
		}
	}

	// Write, read back, rewrite in place (macOS read-modify-write), and
	// append.
	writeAll("/._a.txt", os.O_RDWR|os.O_CREATE|os.O_TRUNC, "xattrs-v1")
	if got := readAll("/._a.txt"); got != "xattrs-v1" {
		t.Errorf("read back = %q", got)
	}
	f, err := fs.OpenFile(ctx, "/._a.txt", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Seek(7, io.SeekStart)
	f.Write([]byte("v2"))
	f.Close()
	writeAll("/._a.txt", os.O_WRONLY|os.O_APPEND, "+more")
	if got := readAll("/._a.txt"); got != "xattrs-v2+more" {
		t.Errorf("after rewrite and append = %q", got)
	}
	if fi, err := fs.Stat(ctx, "/._a.txt"); err != nil || fi.Size() != int64(len("xattrs-v2+more")) {
		t.Errorf("Stat = %v, %v", fi, err)
	}

	// Folders, rename, remove.
	if err := fs.Mkdir(ctx, "/.TemporaryItems", 0o755); err != nil {
		t.Fatal(err)
	}
	writeAll("/.TemporaryItems/._tmp", os.O_RDWR|os.O_CREATE, "t")
	if err := fs.Rename(ctx, "/._a.txt", "/._b.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(ctx, "/._a.txt"); !os.IsNotExist(err) {
		t.Errorf("old name after rename: %v", err)
	}
	if got := readAll("/._b.txt"); got != "xattrs-v2+more" {
		t.Errorf("renamed = %q", got)
	}
	if err := fs.Rename(ctx, "/a.txt", "/._a.txt"); !os.IsPermission(err) {
		t.Errorf("rename of a real file onto metadata = %v, want permission error", err)
	}
	if err := fs.RemoveAll(ctx, "/.TemporaryItems"); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(ctx, "/.TemporaryItems/._tmp"); !os.IsNotExist(err) {
		t.Errorf("child after RemoveAll: %v", err)
	}

	// O_EXCL on existing metadata fails like on a file.
	if _, err := fs.OpenFile(ctx, "/._b.txt", os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644); !os.IsExist(err) {
		t.Errorf("O_EXCL on existing metadata = %v, want exist error", err)
	}

	// Metadata follows a real folder through rename and delete.
	if err := fs.Mkdir(ctx, "/d", 0o755); err != nil {
		t.Fatal(err)
	}
	writeAll("/d/._x", os.O_RDWR|os.O_CREATE, "attrs")
	if err := fs.Rename(ctx, "/d", "/e"); err != nil {
		t.Fatal(err)
	}
	if got := readAll("/e/._x"); got != "attrs" {
		t.Errorf("metadata after folder rename = %q", got)
	}
	if _, err := fs.Stat(ctx, "/d/._x"); !os.IsNotExist(err) {
		t.Errorf("metadata left at the old folder path: %v", err)
	}
	if err := fs.RemoveAll(ctx, "/e"); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(ctx, "/e/._x"); !os.IsNotExist(err) {
		t.Errorf("metadata survived folder delete: %v", err)
	}

	// Oversized metadata is refused.
	big, err := fs.OpenFile(ctx, "/._huge", os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := big.Write(make([]byte, metaFileLimit+1)); err == nil {
		t.Error("write over metaFileLimit succeeded")
	}
	big.Close()

	// Listings show only the real file, and the agent never saw a
	// metadata path; its own copies are untouched.
	d, err := fs.OpenFile(ctx, "/", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := d.Readdir(0)
	if len(entries) != 1 || entries[0].Name() != "a.txt" {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("listing = %v, want only a.txt", names)
	}
	for _, p := range fa.seenPaths() {
		if isMacMetadata(strings.TrimPrefix(p, "/srv/share")) {
			t.Errorf("agent saw metadata path %q", p)
		}
	}

	for _, name := range []string{"/.DS_Store.txt", "/a._b", "/_a"} {
		if isMacMetadata(name) {
			t.Errorf("isMacMetadata(%q) = true", name)
		}
	}
}

// Old metadata is evicted once a share holds more than metaTotalLimit.
func TestMacMetadataEviction(t *testing.T) {
	var s metaStore
	chunk := make([]byte, metaFileLimit)
	for i := 0; i < metaTotalLimit/metaFileLimit+2; i++ {
		f, _ := s.open("/._f"+strconv.Itoa(i), os.O_RDWR|os.O_CREATE)
		f.Write(chunk)
		f.Close()
	}
	if s.total > metaTotalLimit {
		t.Errorf("total = %d, over the limit %d", s.total, metaTotalLimit)
	}
	if _, err := s.stat("/._f0"); !os.IsNotExist(err) {
		t.Errorf("oldest entry survived eviction: %v", err)
	}
	last := "/._f" + strconv.Itoa(metaTotalLimit/metaFileLimit+1)
	if _, err := s.stat(last); err != nil {
		t.Errorf("newest entry evicted: %v", err)
	}
}

func TestReadOnlyFS(t *testing.T) {
	fa := newFakeAgent(t)
	fa.write("/srv/share/a.txt", []byte("hello"))
	fs, _ := newTestFS(t, fa, true)
	ctx := context.Background()

	for _, flag := range []int{os.O_RDWR, os.O_WRONLY, os.O_RDWR | os.O_CREATE | os.O_TRUNC} {
		if _, err := fs.OpenFile(ctx, "/a.txt", flag, 0); !os.IsPermission(err) {
			t.Errorf("open flag %#x: err = %v, want os.IsPermission", flag, err)
		}
	}
	if err := fs.Mkdir(ctx, "/d", 0o755); !os.IsPermission(err) {
		t.Errorf("mkdir: %v", err)
	}
	if err := fs.RemoveAll(ctx, "/a.txt"); !os.IsPermission(err) {
		t.Errorf("remove: %v", err)
	}
	if err := fs.Rename(ctx, "/a.txt", "/b.txt"); !os.IsPermission(err) {
		t.Errorf("rename: %v", err)
	}
	if fa.count("upload")+fa.count("browse:mkdir")+fa.count("browse:delete")+fa.count("browse:rename") != 0 {
		t.Error("read-only FS reached a mutating agent call")
	}
	f, err := fs.OpenFile(ctx, "/a.txt", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got, _ := io.ReadAll(f); string(got) != "hello" {
		t.Errorf("read = %q", got)
	}
}
