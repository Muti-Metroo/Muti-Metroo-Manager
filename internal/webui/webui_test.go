package webui

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// newTestHandler builds a fileHandler over an in-memory dist tree that mirrors
// the shape Vite produces: hashed bundles under assets/, stable-named static
// files at the root, and index.html as the SPA entry point.
func newTestHandler() *fileHandler {
	return &fileHandler{fs: fstest.MapFS{
		"index.html":              {Data: []byte("<html></html>")},
		"assets/index-abc123.js":  {Data: []byte("console.log(1)")},
		"assets/index-abc123.css": {Data: []byte("body{}")},
		"fonts/inter-latin.woff2": {Data: []byte("woff2")},
		"fonts/fonts.css":         {Data: []byte("@font-face{}")},
		"favicon.svg":             {Data: []byte("<svg/>")},
	}}
}

func TestCacheControl(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		// Hashed bundles change URL on every build, so they never go stale.
		{"hashed js", "/assets/index-abc123.js", immutableAsset},
		{"hashed css", "/assets/index-abc123.css", immutableAsset},
		// Stable filenames: cacheable, but must not outlive an upgrade by
		// more than a day.
		{"vendored font", "/fonts/inter-latin.woff2", staticAsset},
		{"font stylesheet", "/fonts/fonts.css", staticAsset},
		{"favicon", "/favicon.svg", staticAsset},
		// The SPA entry point names the current bundle hashes.
		{"index", "/index.html", noStore},
		{"root", "/", noStore},
		// Client-side routes fall back to index.html and must not be cached
		// either, or an upgraded server would still hand out the old bundle.
		{"spa fallback", "/topology", noStore},
	}

	h := newTestHandler()
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Cache-Control"); got != tc.want {
				t.Errorf("Cache-Control = %q, want %q", got, tc.want)
			}
		})
	}
}

// A missing asset still renders the 404 page, and must not be cached as if it
// were the real file.
func TestNotFoundIsNotCached(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/missing.png", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Errorf("Cache-Control = %q, want it unset on a 404", got)
	}
}

func TestFontContentType(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/fonts/inter-latin.woff2", nil))

	if got := rec.Header().Get("Content-Type"); got != "font/woff2" {
		t.Errorf("Content-Type = %q, want %q", got, "font/woff2")
	}
}
