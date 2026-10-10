package webui

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Handler returns an http.Handler that serves the embedded Vite build output.
// It falls back to index.html for SPA client-side routing.
func Handler() http.Handler {
	content, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("failed to access embedded dist files: " + err.Error())
	}
	return &fileHandler{fs: content}
}

type fileHandler struct {
	fs fs.FS
}

func (h *fileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	urlPath := path.Clean(r.URL.Path)
	if urlPath == "" || urlPath == "/" {
		urlPath = "index.html"
	} else {
		urlPath = strings.TrimPrefix(urlPath, "/")
	}

	f, err := h.fs.Open(urlPath)
	if err != nil {
		// SPA fallback: extensionless paths look like client-side routes
		// (e.g. /routes/test, /topology) — serve index.html so the React
		// router can take over. Real asset misses (paths with extensions
		// like /foo.png) keep the 404 page.
		if path.Ext(urlPath) == "" {
			h.serveIndex(w, r)
			return
		}
		h.serveNotFound(w, r)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// servedPath, not urlPath: a directory request falls through to the
	// index.html inside it, and the headers have to describe what is actually
	// written (HTML, uncacheable), not the directory that was asked for.
	servedPath := urlPath
	if stat.IsDir() {
		servedPath = path.Join(urlPath, "index.html")
		indexFile, err := h.fs.Open(servedPath)
		if err != nil {
			h.serveNotFound(w, r)
			return
		}
		defer indexFile.Close()
		f = indexFile
	}

	if ct := contentType(servedPath); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", cacheControl(servedPath))

	content, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	w.Write(content)
}

func (h *fileHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	f, err := h.fs.Open("index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", noStore)
	content, _ := io.ReadAll(f)
	w.WriteHeader(http.StatusOK)
	w.Write(content)
}

// notFoundPage is the static fallback for asset misses (paths with an
// extension that isn't in dist/). The illustration is inlined as SVG
// so a missing /notfound.png cannot leave the page with a broken
// glyph — important when the page is shown on a critical-systems
// console where every visual cue matters.
const notFoundPage = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 — Not Found</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: radial-gradient(ellipse at 50% 60%, #d5cbbe 0%, #c4b8a6 25%, #b0a48f 50%, #9a8e7a 75%, #857968 100%);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #3a3228;
        }
        svg.glyph { width: 128px; height: 128px; margin-bottom: 1.5rem; opacity: 0.7; }
        h1 { font-size: 1.4rem; font-weight: 400; }
        p  { font-size: 0.9rem; opacity: 0.7; font-family: monospace; margin-top: 0.5rem; }
    </style>
</head>
<body>
    <svg class="glyph" viewBox="0 0 64 64" fill="none" stroke="#3a3228" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="32" cy="32" r="28" />
        <line x1="22" y1="40" x2="42" y2="40" />
        <circle cx="24" cy="26" r="2" fill="#3a3228" />
        <circle cx="40" cy="26" r="2" fill="#3a3228" />
    </svg>
    <h1>404 — page not found</h1>
    <p>The requested resource is not available on this server.</p>
</body>
</html>
`

func (h *fileHandler) serveNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	io.WriteString(w, notFoundPage)
}

// Cache-Control values for the embedded build output.
const (
	// Vite fingerprints everything under assets/ with a content hash, so a
	// changed file always arrives under a new URL and the old one can be
	// cached indefinitely.
	immutableAsset = "public, max-age=31536000, immutable"
	// Everything else keeps a stable filename across builds (fonts,
	// favicons, logo.png), so it may only be cached for a day: a Muti Metroo Manager
	// upgrade that re-vendors a font has to reach operators without a hard
	// reload.
	staticAsset = "public, max-age=86400"
	// index.html carries the current asset hashes. Caching it would pin a
	// browser to the previous build's bundle after an upgrade.
	noStore = "no-cache"
)

// cacheControl picks the caching policy for a path inside dist/.
func cacheControl(filePath string) string {
	switch {
	case filePath == "index.html" || strings.HasSuffix(filePath, "/index.html"):
		return noStore
	case strings.HasPrefix(filePath, "assets/"):
		return immutableAsset
	default:
		return staticAsset
	}
}

func contentType(filePath string) string {
	switch {
	case strings.HasSuffix(filePath, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(filePath, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(filePath, ".js"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(filePath, ".json"):
		return "application/json; charset=utf-8"
	case strings.HasSuffix(filePath, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(filePath, ".png"):
		return "image/png"
	case strings.HasSuffix(filePath, ".ico"):
		return "image/x-icon"
	case strings.HasSuffix(filePath, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(filePath, ".woff"):
		return "font/woff"
	default:
		return ""
	}
}
