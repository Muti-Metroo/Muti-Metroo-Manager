package davshare

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/net/webdav"
)

const exclusiveLock = `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`

// TestMoveLockedResource: a client that holds a lock on a file can move it to
// a new name by presenting its lock token, as davfs2 does on every rename.
// Without a token the move is refused, and a destination locked by another
// client stays protected.
func TestMoveLockedResource(t *testing.T) {
	h := &webdav.Handler{Prefix: "/dav/x", FileSystem: webdav.Dir(t.TempDir()), LockSystem: newLockSystem()}
	srv := httptest.NewServer(h)
	defer srv.Close()

	do := func(method, path string, hdr map[string]string, body string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	lock := func(path string) string {
		t.Helper()
		r := do("LOCK", path, map[string]string{"Content-Type": "application/xml"}, exclusiveLock)
		if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
			t.Fatalf("LOCK %s: %d", path, r.StatusCode)
		}
		return r.Header.Get("Lock-Token")
	}

	tok := lock("/dav/x/a.txt")
	if r := do("MOVE", "/dav/x/a.txt", map[string]string{"Destination": srv.URL + "/dav/x/b.txt"}, ""); r.StatusCode != http.StatusLocked {
		t.Errorf("move without token: %d, want 423", r.StatusCode)
	}
	if r := do("MOVE", "/dav/x/a.txt", map[string]string{
		"Destination": srv.URL + "/dav/x/b.txt",
		"If":          "<" + srv.URL + "/dav/x/a.txt> (" + tok + ")",
	}, ""); r.StatusCode != http.StatusCreated {
		t.Errorf("tagged move with token: %d, want 201", r.StatusCode)
	}

	tok = lock("/dav/x/c.txt")
	lock("/dav/x/d.txt") // held by another client
	if r := do("MOVE", "/dav/x/c.txt", map[string]string{
		"Destination": srv.URL + "/dav/x/d.txt",
		"Overwrite":   "T",
		"If":          "(" + tok + ")",
	}, ""); r.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("move onto a resource locked by another client: %d, want 412", r.StatusCode)
	}
	if r := do("MOVE", "/dav/x/c.txt", map[string]string{
		"Destination": srv.URL + "/dav/x/e.txt",
		"If":          "(" + tok + ")",
	}, ""); r.StatusCode != http.StatusCreated {
		t.Errorf("untagged move with token: %d, want 201", r.StatusCode)
	}
}
