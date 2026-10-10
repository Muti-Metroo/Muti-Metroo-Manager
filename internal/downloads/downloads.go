// Package downloads serves files out of a muti-metroo-downloads-bundle.zip
// dropped next to the muti-metroo-manager binary.
//
// The bundle ships every Muti Metroo / Mutiauk binary plus the user manual,
// so operators can hand them to end users without exposing the private
// GitHub releases. When no bundle is present the feature is silently
// disabled and the UI hides the Downloads tab.
package downloads

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

// Bundle is a read-only handle to an opened downloads zip. Safe for
// concurrent use across HTTP handlers — the underlying *zip.ReadCloser
// indexes the archive once and serves each request from its own
// io.ReadCloser via (*zip.File).Open.
type Bundle struct {
	rc            *zip.ReadCloser
	manifestRaw   []byte
	manifest      Manifest
	files         map[string]*zip.File
	downloadNames map[string]string // archive-name → user-facing download filename
}

// Manifest mirrors the manifest.json shape produced by bundle-downloads.sh.
type Manifest struct {
	MutiMetrooVersion string         `json:"muti_metroo_version"`
	EntryVersion      string         `json:"entry_version"`
	GeneratedAt       string         `json:"generated_at"`
	Files             []ManifestFile `json:"files"`
}

// ManifestFile describes a single artifact inside the bundle.
//   - Name is the filename inside the zip.
//   - DownloadName is what the browser saves the file as (Content-Disposition).
//   - OS, Arch, Type drive the columns shown in the UI.
type ManifestFile struct {
	Name         string `json:"name"`
	DownloadName string `json:"download_name,omitempty"`
	Category     string `json:"category"`
	OS           string `json:"os,omitempty"`
	Arch         string `json:"arch,omitempty"`
	Type         string `json:"type,omitempty"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
	Version      string `json:"version,omitempty"`
}

// Open reads the bundle at path, validates its manifest, and returns a
// Bundle ready to serve. The caller should defer Close on shutdown.
func Open(p string) (*Bundle, error) {
	rc, err := zip.OpenReader(p)
	if err != nil {
		return nil, fmt.Errorf("open zip: %w", err)
	}

	files := make(map[string]*zip.File, len(rc.File))
	for _, f := range rc.File {
		// Reject anything with a path separator: the bundle is supposed
		// to be flat, and a nested entry would break the simple lookup
		// model below (and could be a vector for confusion).
		if strings.ContainsAny(f.Name, "/\\") {
			rc.Close()
			return nil, fmt.Errorf("bundle contains nested entry %q", f.Name)
		}
		files[f.Name] = f
	}

	mf, ok := files["manifest.json"]
	if !ok {
		rc.Close()
		return nil, errors.New("bundle is missing manifest.json")
	}
	mr, err := mf.Open()
	if err != nil {
		rc.Close()
		return nil, fmt.Errorf("open manifest.json: %w", err)
	}
	raw, err := io.ReadAll(mr)
	mr.Close()
	if err != nil {
		rc.Close()
		return nil, fmt.Errorf("read manifest.json: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		rc.Close()
		return nil, fmt.Errorf("parse manifest.json: %w", err)
	}

	// Sanity-check that every file in the manifest is actually in the zip,
	// and build the archive→download name lookup. If they drift apart we
	// want to fail at open time, not at request time.
	downloadNames := make(map[string]string, len(m.Files))
	for _, fm := range m.Files {
		if _, ok := files[fm.Name]; !ok {
			rc.Close()
			return nil, fmt.Errorf("manifest references missing file %q", fm.Name)
		}
		if fm.DownloadName != "" {
			downloadNames[fm.Name] = fm.DownloadName
		}
	}

	return &Bundle{
		rc:            rc,
		manifestRaw:   raw,
		manifest:      m,
		files:         files,
		downloadNames: downloadNames,
	}, nil
}

// Close releases the underlying zip handle.
func (b *Bundle) Close() error {
	if b == nil {
		return nil
	}
	return b.rc.Close()
}

// ManifestJSON returns the cached manifest body (already canonical JSON
// produced by bundle-downloads.sh).
func (b *Bundle) ManifestJSON() []byte { return b.manifestRaw }

// Manifest returns the parsed manifest.
func (b *Bundle) Manifest() Manifest { return b.manifest }

// File opens a single bundled file by archive name. Returns the file
// content reader, its size, and the user-facing download filename
// (falls back to the archive name when the manifest doesn't override).
// The caller should already have rejected anything with a slash, but
// this method also refuses traversal patterns as a belt-and-suspenders
// check.
func (b *Bundle) File(name string) (io.ReadCloser, int64, string, error) {
	if name == "" || name == "manifest.json" {
		return nil, 0, "", os.ErrNotExist
	}
	// Disallow path separators, parent traversal, and absolute paths.
	if strings.ContainsAny(name, "/\\") || name == "." || name == ".." || path.IsAbs(name) {
		return nil, 0, "", os.ErrNotExist
	}
	f, ok := b.files[name]
	if !ok {
		return nil, 0, "", os.ErrNotExist
	}
	rc, err := f.Open()
	if err != nil {
		return nil, 0, "", err
	}
	dn := b.downloadNames[name]
	if dn == "" {
		dn = name
	}
	return rc, int64(f.UncompressedSize64), dn, nil
}
