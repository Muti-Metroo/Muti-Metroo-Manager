package downloads

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// makeTestBundle writes a minimal valid bundle to a temp dir and returns
// its path. Each entry in files is (name, content).
func makeTestBundle(t *testing.T, manifest string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "bundle.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	w := zip.NewWriter(f)
	if manifest != "" {
		mw, err := w.Create("manifest.json")
		if err != nil {
			t.Fatalf("create manifest entry: %v", err)
		}
		mw.Write([]byte(manifest))
	}
	for name, content := range files {
		fw, err := w.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		fw.Write([]byte(content))
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return p
}

func TestOpenAndServe(t *testing.T) {
	manifest := `{
		"muti_metroo_version": "v1.2.3",
		"entry_version": "v0.1.0",
		"generated_at": "2026-04-27T00:00:00Z",
		"files": [
			{"name": "muti-metroo-linux-amd64", "download_name": "muti-metroo", "category": "agent", "os": "Linux", "arch": "amd64", "type": "executable", "size": 5, "sha256": "x", "version": "v1.2.3"}
		]
	}`
	p := makeTestBundle(t, manifest, map[string]string{
		"muti-metroo-linux-amd64": "hello",
	})

	b, err := Open(p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer b.Close()

	if got := b.Manifest().MutiMetrooVersion; got != "v1.2.3" {
		t.Errorf("MutiMetrooVersion = %q, want v1.2.3", got)
	}
	if len(b.Manifest().Files) != 1 {
		t.Errorf("Files count = %d, want 1", len(b.Manifest().Files))
	}

	rc, size, downloadName, err := b.File("muti-metroo-linux-amd64")
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	defer rc.Close()
	if size != 5 {
		t.Errorf("size = %d, want 5", size)
	}
	if downloadName != "muti-metroo" {
		t.Errorf("downloadName = %q, want muti-metroo", downloadName)
	}
	body, _ := io.ReadAll(rc)
	if string(body) != "hello" {
		t.Errorf("body = %q, want hello", body)
	}
}

func TestFileFallsBackToArchiveName(t *testing.T) {
	manifest := `{"muti_metroo_version":"v1","entry_version":"v1","generated_at":"x","files":[{"name":"oddball","category":"agent","size":1,"sha256":""}]}`
	p := makeTestBundle(t, manifest, map[string]string{"oddball": "z"})
	b, err := Open(p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer b.Close()
	_, _, dn, err := b.File("oddball")
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if dn != "oddball" {
		t.Errorf("downloadName = %q, want oddball", dn)
	}
}

func TestRejectsMissingManifest(t *testing.T) {
	p := makeTestBundle(t, "", map[string]string{"x": "y"})
	if _, err := Open(p); err == nil {
		t.Fatal("expected error for missing manifest.json")
	}
}

func TestRejectsManifestRefToMissingFile(t *testing.T) {
	manifest := `{"muti_metroo_version":"v1","entry_version":"v1","generated_at":"x","files":[{"name":"ghost","category":"agent","platform":"","size":0,"sha256":"","version":""}]}`
	p := makeTestBundle(t, manifest, map[string]string{})
	if _, err := Open(p); err == nil {
		t.Fatal("expected error when manifest references missing file")
	}
}

func TestRejectsNestedEntries(t *testing.T) {
	manifest := `{"muti_metroo_version":"v1","entry_version":"v1","generated_at":"x","files":[]}`
	p := makeTestBundle(t, manifest, map[string]string{
		"sub/dir/file": "x",
	})
	if _, err := Open(p); err == nil {
		t.Fatal("expected error for nested entry")
	}
}

func TestFileRejectsTraversal(t *testing.T) {
	manifest := `{"muti_metroo_version":"v1","entry_version":"v1","generated_at":"x","files":[]}`
	p := makeTestBundle(t, manifest, map[string]string{})
	b, err := Open(p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer b.Close()

	for _, name := range []string{"", ".", "..", "../etc/passwd", "foo/bar", `foo\bar`, "/etc/passwd", "manifest.json"} {
		if _, _, _, err := b.File(name); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("File(%q) err = %v, want ErrNotExist", name, err)
		}
	}
}

func TestOpenMissingFile(t *testing.T) {
	_, err := Open(filepath.Join(t.TempDir(), "nope.zip"))
	if err == nil {
		t.Fatal("expected error opening missing file")
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("err = %v, want wrapping ErrNotExist", err)
	}
}
