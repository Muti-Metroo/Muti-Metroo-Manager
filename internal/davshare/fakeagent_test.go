package davshare

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const fakeAgentID = "0123456789abcdef0123456789abcdef"

// fakeAgent implements the agent's file/browse, file/download and
// file/upload endpoints on top of a real temp directory. Paths outside
// allowed are refused with not_allowed, like file_transfer.allowed_paths.
type fakeAgent struct {
	t       *testing.T
	dir     string // the "agent filesystem" root; agent paths are absolute under it
	allowed string // agent path prefix that may be touched
	srv     *httptest.Server

	mu        sync.Mutex
	calls     map[string]int // "browse:stat", "download", "upload", ...
	downloads []rangeReq
	paths     []string // every agent path requested
	token     string
}

type rangeReq struct{ off, length int64 }

func newFakeAgent(t *testing.T) *fakeAgent {
	t.Helper()
	fa := &fakeAgent{t: t, dir: t.TempDir(), allowed: "/srv/share", calls: map[string]int{}, token: "agent-token"}
	if err := os.MkdirAll(filepath.Join(fa.dir, "srv", "share"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fa.dir, "srv", "secret"), 0o755); err != nil {
		t.Fatal(err)
	}
	fa.srv = httptest.NewServer(http.HandlerFunc(fa.serve))
	t.Cleanup(fa.srv.Close)
	return fa
}

func (fa *fakeAgent) client() *AgentClient {
	return NewAgentClient(fa.srv.URL, fa.token, nil)
}

func (fa *fakeAgent) local(p string) string { return filepath.Join(fa.dir, filepath.FromSlash(p)) }

func (fa *fakeAgent) write(p string, data []byte) {
	fa.t.Helper()
	if err := os.MkdirAll(filepath.Dir(fa.local(p)), 0o755); err != nil {
		fa.t.Fatal(err)
	}
	if err := os.WriteFile(fa.local(p), data, 0o644); err != nil {
		fa.t.Fatal(err)
	}
}

func (fa *fakeAgent) read(p string) ([]byte, error) { return os.ReadFile(fa.local(p)) }

func (fa *fakeAgent) count(key string) int {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	return fa.calls[key]
}

func (fa *fakeAgent) reset() {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	fa.calls = map[string]int{}
	fa.downloads = nil
}

func (fa *fakeAgent) ranges() []rangeReq {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	return append([]rangeReq(nil), fa.downloads...)
}

func (fa *fakeAgent) seenPaths() []string {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	return append([]string(nil), fa.paths...)
}

func (fa *fakeAgent) note(key, p string) {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	fa.calls[key]++
	if p != "" {
		fa.paths = append(fa.paths, p)
	}
}

func (fa *fakeAgent) isAllowed(p string) bool {
	return p == fa.allowed || strings.HasPrefix(p, fa.allowed+"/")
}

func entryOf(name string, fi os.FileInfo) FileEntry {
	return FileEntry{
		Name:    name,
		Size:    fi.Size(),
		Mode:    fmt.Sprintf("%04o", fi.Mode().Perm()),
		ModTime: fi.ModTime().UTC().Format(time.RFC3339),
		IsDir:   fi.IsDir(),
	}
}

func (fa *fakeAgent) browseErr(w http.ResponseWriter, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(map[string]any{"error": msg, "error_code": code, "total": 0, "truncated": false})
}

func (fa *fakeAgent) transferErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"success": false, "error": msg, "code": code})
}

func (fa *fakeAgent) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+fa.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	prefix := "/agents/" + fakeAgentID + "/file/"
	op, ok := strings.CutPrefix(r.URL.Path, prefix)
	if !ok || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	switch op {
	case "browse":
		fa.serveBrowse(w, r)
	case "download":
		fa.serveDownload(w, r)
	case "upload":
		fa.serveUpload(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (fa *fakeAgent) serveBrowse(w http.ResponseWriter, r *http.Request) {
	var in browseRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fa.note("browse:"+in.Action, in.Path)
	if in.NewPath != "" {
		fa.note("browse:new_path", in.NewPath)
	}
	if !fa.isAllowed(in.Path) || (in.NewPath != "" && !fa.isAllowed(in.NewPath)) {
		fa.browseErr(w, "not_allowed", "path not in allowed list: "+in.Path)
		return
	}
	lp := fa.local(in.Path)
	var out browseResponse
	switch in.Action {
	case "stat":
		fi, err := os.Stat(lp)
		if err != nil {
			fa.browseErr(w, "not_found", "path not found: "+in.Path)
			return
		}
		e := entryOf(filepath.Base(lp), fi)
		out.Entry = &e
	case "list":
		des, err := os.ReadDir(lp)
		if err != nil {
			fa.browseErr(w, "not_found", "path not found: "+in.Path)
			return
		}
		sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
		limit := in.Limit
		if limit <= 0 {
			limit = 100
		}
		end := min(in.Offset+limit, len(des))
		for _, de := range des[min(in.Offset, len(des)):end] {
			fi, _ := de.Info()
			out.Entries = append(out.Entries, entryOf(de.Name(), fi))
		}
		out.Truncated = end < len(des)
	case "mkdir":
		if err := os.Mkdir(lp, 0o755); err != nil {
			if errors.Is(err, fs.ErrExist) {
				fa.browseErr(w, "already_exists", "already exists: "+in.Path)
			} else {
				fa.browseErr(w, "not_found", "parent not found: "+in.Path)
			}
			return
		}
	case "rename":
		if _, err := os.Lstat(fa.local(in.NewPath)); err == nil {
			fa.browseErr(w, "already_exists", "destination already exists: "+in.NewPath)
			return
		}
		if err := os.Rename(lp, fa.local(in.NewPath)); err != nil {
			fa.browseErr(w, "not_found", "path not found: "+in.Path)
			return
		}
	case "delete":
		if _, err := os.Lstat(lp); err != nil {
			fa.browseErr(w, "not_found", "path not found: "+in.Path)
			return
		}
		var err error
		if in.Recursive {
			err = os.RemoveAll(lp)
		} else {
			err = os.Remove(lp)
		}
		if err != nil {
			fa.browseErr(w, "not_empty", "directory is not empty (use recursive to delete)")
			return
		}
	default:
		fa.browseErr(w, "", "unknown action: "+in.Action)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (fa *fakeAgent) serveDownload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
		Length int64  `json:"length"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fa.note("download", in.Path)
	fa.mu.Lock()
	fa.downloads = append(fa.downloads, rangeReq{in.Offset, in.Length})
	fa.mu.Unlock()
	if !fa.isAllowed(in.Path) {
		fa.transferErr(w, http.StatusBadGateway, "not_allowed", "remote error: path not in allowed list: "+in.Path)
		return
	}
	data, err := os.ReadFile(fa.local(in.Path))
	if err != nil {
		fa.transferErr(w, http.StatusBadGateway, "not_found", "remote error: path not found: "+in.Path)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Original-Size", fmt.Sprint(len(data)))
	w.Header().Set("X-File-Mode", "0644")
	off := min(in.Offset, int64(len(data)))
	end := int64(len(data))
	if in.Length > 0 {
		end = min(off+in.Length, end)
	}
	w.Write(data[off:end])
}

func (fa *fakeAgent) serveUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	p := r.FormValue("path")
	fa.note("upload", p)
	if !fa.isAllowed(p) {
		fa.transferErr(w, http.StatusBadGateway, "not_allowed", "remote error: path not in allowed list: "+p)
		return
	}
	f, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer f.Close()
	data, _ := io.ReadAll(f)
	if err := os.MkdirAll(filepath.Dir(fa.local(p)), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(fa.local(p), data, 0o600); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "bytes_written": len(data)})
}
