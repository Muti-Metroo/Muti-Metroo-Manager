package davshare

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/store"
)

type memShares struct {
	mu sync.Mutex
	m  map[string]store.Share
}

func (s *memShares) GetShareByName(name string) (store.Share, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.m[name]
	if !ok {
		return store.Share{}, store.ErrShareNotFound
	}
	return sh, nil
}

func (s *memShares) set(sh store.Share) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[sh.Name] = sh
}

type gwFixture struct {
	fa     *fakeAgent
	shares *memShares
	gw     *Gateway
	srv    *httptest.Server
}

func newGatewayFixture(t *testing.T) *gwFixture {
	t.Helper()
	fa := newFakeAgent(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("s3cret-pass"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	shares := &memShares{m: map[string]store.Share{}}
	base := store.Share{AgentID: fakeAgentID, RemotePath: "/srv/share", Username: "alice",
		PasswordHash: string(hash), Enabled: true}
	rw, ro, off := base, base, base
	rw.ID, rw.Name = 1, "rw"
	ro.ID, ro.Name, ro.ReadOnly = 2, "ro", true
	off.ID, off.Name, off.Enabled = 3, "off", false
	shares.set(rw)
	shares.set(ro)
	shares.set(off)

	gw := NewGateway(shares, fa.client(), slog.New(slog.NewTextHandler(io.Discard, nil)), t.TempDir())
	mux := http.NewServeMux()
	mux.Handle(Prefix, gw)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &gwFixture{fa: fa, shares: shares, gw: gw, srv: srv}
}

func (f *gwFixture) do(t *testing.T, method, path, body string, hdr map[string]string, auth bool) *http.Response {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, f.srv.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if auth {
		req.SetBasicAuth("alice", "s3cret-pass")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestGatewayRequiresBasicAuth(t *testing.T) {
	f := newGatewayFixture(t)
	for _, m := range []string{"GET", "PROPFIND", "OPTIONS", "PUT", "DELETE"} {
		resp := f.do(t, m, "/dav/rw/", "", nil, false)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s without credentials = %d, want 401", m, resp.StatusCode)
		}
		if !strings.HasPrefix(resp.Header.Get("WWW-Authenticate"), "Basic ") {
			t.Errorf("%s: WWW-Authenticate = %q", m, resp.Header.Get("WWW-Authenticate"))
		}
	}
	// A bearer token (the manager's /api credential) is not a share credential.
	resp := f.do(t, "PROPFIND", "/dav/rw/", "", map[string]string{"Authorization": "Bearer whatever"}, false)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("bearer token = %d, want 401", resp.StatusCode)
	}
	if n := len(f.fa.seenPaths()); n != 0 {
		t.Errorf("unauthenticated requests reached the agent %d times", n)
	}

	req, _ := http.NewRequest("PROPFIND", f.srv.URL+"/dav/rw/", nil)
	req.SetBasicAuth("bob", "s3cret-pass")
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong user = %d, want 401", resp.StatusCode)
	}
	req, _ = http.NewRequest("PROPFIND", f.srv.URL+"/dav/rw/", nil)
	req.SetBasicAuth("alice", "nope")
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong password = %d, want 401", resp.StatusCode)
	}

	if resp := f.do(t, "PROPFIND", "/dav/rw/", "", map[string]string{"Depth": "1"}, true); resp.StatusCode != http.StatusMultiStatus {
		t.Errorf("valid credentials = %d, want 207", resp.StatusCode)
	}
}

func TestGatewayUnknownAndDisabled(t *testing.T) {
	f := newGatewayFixture(t)
	for _, p := range []string{"/dav/missing/", "/dav/off/", "/dav/Bad%20Name/", "/dav/"} {
		if resp := f.do(t, "PROPFIND", p, "", nil, true); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", p, resp.StatusCode)
		}
	}
}

func TestGatewayThrottlesFailedAuth(t *testing.T) {
	f := newGatewayFixture(t)
	for i := 0; i < maxAuthFailures; i++ {
		req, _ := http.NewRequest("PROPFIND", f.srv.URL+"/dav/rw/", nil)
		req.SetBasicAuth("alice", "wrong")
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d, want 401", i, resp.StatusCode)
		}
	}
	resp := f.do(t, "PROPFIND", "/dav/rw/", "", nil, true)
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") == "" {
		t.Errorf("after %d failures = %d (Retry-After %q), want 429", maxAuthFailures, resp.StatusCode, resp.Header.Get("Retry-After"))
	}
}

func TestFailLimiterWindow(t *testing.T) {
	l := failLimiter{m: newTTLMap[string, *failRecord](maxLimiterEntries)}
	now := timeAt(0)
	for i := 0; i < maxAuthFailures; i++ {
		l.fail("1.2.3.4", now)
	}
	if l.blocked("1.2.3.4", now) == 0 {
		t.Fatal("not blocked after max failures")
	}
	if l.blocked("5.6.7.8", now) != 0 {
		t.Error("another IP is blocked")
	}
	if l.blocked("1.2.3.4", now.Add(authFailWindow)) != 0 {
		t.Error("still blocked after the window")
	}
}

func TestFailLimiterBounded(t *testing.T) {
	l := failLimiter{m: newTTLMap[string, *failRecord](3)}
	now := timeAt(0)
	for i := 0; i < 10; i++ {
		l.fail(string(rune('a'+i)), now)
		if n := len(l.m.m); n > 3 {
			t.Fatalf("limiter holds %d entries, want <= 3", n)
		}
	}
}

func TestLimiterKey(t *testing.T) {
	cases := map[string]string{
		"1.2.3.4":             "1.2.3.4",
		"::ffff:1.2.3.4":      "::ffff:1.2.3.4",
		"2001:db8:1:2:3::4":   "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff::": "2001:db8:1:2::/64",
		"not-an-ip":           "not-an-ip",
	}
	for in, want := range cases {
		if got := limiterKey(in); got != want {
			t.Errorf("limiterKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGatewayReadOnly(t *testing.T) {
	f := newGatewayFixture(t)
	f.fa.write("/srv/share/a.txt", []byte("hello"))
	cases := []struct {
		method string
		hdr    map[string]string
	}{
		{"PUT", nil},
		{"DELETE", nil},
		{"MKCOL", nil},
		{"PROPPATCH", nil},
		{"LOCK", nil},
		{"UNLOCK", map[string]string{"Lock-Token": "<x>"}},
		{"COPY", map[string]string{"Destination": f.srv.URL + "/dav/ro/b.txt"}},
		{"MOVE", map[string]string{"Destination": f.srv.URL + "/dav/ro/b.txt"}},
	}
	for _, tc := range cases {
		resp := f.do(t, tc.method, "/dav/ro/a.txt", "x", tc.hdr, true)
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s on read-only share = %d, want 403", tc.method, resp.StatusCode)
		}
	}
	if f.fa.count("upload")+f.fa.count("browse:delete")+f.fa.count("browse:mkdir")+f.fa.count("browse:rename") != 0 {
		t.Error("read-only share reached a mutating agent call")
	}
	resp := f.do(t, "GET", "/dav/ro/a.txt", "", nil, true)
	if body, _ := io.ReadAll(resp.Body); resp.StatusCode != http.StatusOK || string(body) != "hello" {
		t.Errorf("GET on read-only share = %d %q", resp.StatusCode, body)
	}
}

// Files from an agent are served on the manager's origin; they must not
// be able to run script there.
func TestGatewaySandboxesContent(t *testing.T) {
	f := newGatewayFixture(t)
	f.fa.write("/srv/share/evil.html", []byte("<script>fetch('/api/shares')</script>"))
	resp := f.do(t, "GET", "/dav/rw/evil.html", "", nil, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET = %d", resp.StatusCode)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox") {
		t.Errorf("Content-Security-Policy = %q, want sandbox", csp)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Error("missing X-Content-Type-Options: nosniff")
	}
}

func TestGatewayReadWriteRoundTrip(t *testing.T) {
	f := newGatewayFixture(t)

	if resp := f.do(t, "MKCOL", "/dav/rw/docs", "", nil, true); resp.StatusCode != http.StatusCreated {
		t.Fatalf("MKCOL = %d", resp.StatusCode)
	}
	if resp := f.do(t, "PUT", "/dav/rw/docs/note.txt", "0123456789", nil, true); resp.StatusCode != http.StatusCreated {
		t.Fatalf("PUT = %d", resp.StatusCode)
	}
	if got, _ := f.fa.read("/srv/share/docs/note.txt"); string(got) != "0123456789" {
		t.Errorf("agent content = %q", got)
	}
	if resp := f.do(t, "PUT", "/dav/rw/nodir/x.txt", "x", nil, true); resp.StatusCode != http.StatusConflict {
		t.Errorf("PUT into missing collection = %d, want 409", resp.StatusCode)
	}

	resp := f.do(t, "GET", "/dav/rw/docs/note.txt", "", map[string]string{"Range": "bytes=3-6"}, true)
	if body, _ := io.ReadAll(resp.Body); resp.StatusCode != http.StatusPartialContent || string(body) != "3456" {
		t.Errorf("ranged GET = %d %q", resp.StatusCode, body)
	}

	resp = f.do(t, "PROPFIND", "/dav/rw/docs/", "", map[string]string{"Depth": "1"}, true)
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusMultiStatus || !strings.Contains(string(body), "/dav/rw/docs/note.txt") {
		t.Errorf("PROPFIND = %d %s", resp.StatusCode, body)
	}
	if resp := f.do(t, "PROPFIND", "/dav/rw/", "", map[string]string{"Depth": "infinity"}, true); resp.StatusCode != http.StatusForbidden {
		t.Errorf("PROPFIND Depth: infinity = %d, want 403", resp.StatusCode)
	}

	resp = f.do(t, "MOVE", "/dav/rw/docs/note.txt", "", map[string]string{"Destination": f.srv.URL + "/dav/rw/docs/renamed.txt"}, true)
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("MOVE = %d", resp.StatusCode)
	}
	if got, _ := f.fa.read("/srv/share/docs/renamed.txt"); string(got) != "0123456789" {
		t.Errorf("after MOVE = %q", got)
	}

	resp = f.do(t, "COPY", "/dav/rw/docs/renamed.txt", "", map[string]string{"Destination": f.srv.URL + "/dav/rw/copy.txt"}, true)
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("COPY = %d", resp.StatusCode)
	}
	if got, _ := f.fa.read("/srv/share/copy.txt"); string(got) != "0123456789" {
		t.Errorf("after COPY = %q", got)
	}

	// LOCK / UNLOCK work on a writable share (Finder needs them to mount read-write).
	lockBody := `<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`
	resp = f.do(t, "LOCK", "/dav/rw/copy.txt", lockBody, map[string]string{"Timeout": "Second-60"}, true)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Lock-Token") == "" {
		t.Fatalf("LOCK = %d", resp.StatusCode)
	}
	token := resp.Header.Get("Lock-Token")
	if resp := f.do(t, "PUT", "/dav/rw/copy.txt", "y", nil, true); resp.StatusCode != http.StatusLocked {
		t.Errorf("PUT on locked file without token = %d, want 423", resp.StatusCode)
	}
	if resp := f.do(t, "UNLOCK", "/dav/rw/copy.txt", "", map[string]string{"Lock-Token": token}, true); resp.StatusCode != http.StatusNoContent {
		t.Errorf("UNLOCK = %d", resp.StatusCode)
	}

	if resp := f.do(t, "DELETE", "/dav/rw/docs/", "", nil, true); resp.StatusCode != http.StatusNoContent {
		t.Errorf("DELETE = %d", resp.StatusCode)
	}
	if _, err := f.fa.read("/srv/share/docs/renamed.txt"); err == nil {
		t.Error("DELETE left the collection in place")
	}
	assertConfined(t, f.fa)
}

func TestGatewayPathTraversal(t *testing.T) {
	f := newGatewayFixture(t)
	f.fa.write("/srv/secret/passwd", []byte("root"))
	// Call the gateway directly so ServeMux path cleaning cannot hide a
	// traversal the gateway itself would let through.
	for _, p := range []string{"/dav/rw/../secret/passwd", "/dav/rw/..%2f..%2fsecret/passwd", "/dav/rw/a\\..\\..\\secret\\passwd"} {
		req := httptest.NewRequest("GET", "http://manager"+strings.ReplaceAll(p, "\\", "%5C"), nil)
		req.SetBasicAuth("alice", "s3cret-pass")
		rec := httptest.NewRecorder()
		f.gw.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), "root") {
			t.Errorf("%s = %d %q, want refusal", p, rec.Code, rec.Body.String())
		}
	}
	assertConfined(t, f.fa)
}

func TestCredentialCacheInvalidatedByRotation(t *testing.T) {
	f := newGatewayFixture(t)
	if resp := f.do(t, "PROPFIND", "/dav/rw/", "", nil, true); resp.StatusCode != http.StatusMultiStatus {
		t.Fatalf("first auth = %d", resp.StatusCode)
	}
	sh, _ := f.shares.GetShareByName("rw")
	hash, _ := bcrypt.GenerateFromPassword([]byte("new-password"), bcrypt.MinCost)
	sh.PasswordHash = string(hash)
	f.shares.set(sh)
	if resp := f.do(t, "PROPFIND", "/dav/rw/", "", nil, true); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("old password after rotation = %d, want 401", resp.StatusCode)
	}
}

func TestGeneratePassword(t *testing.T) {
	a, err := GeneratePassword()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := GeneratePassword()
	if len(a) != 20 || a == b {
		t.Errorf("passwords %q / %q", a, b)
	}
	for _, c := range a {
		if !strings.ContainsRune(passwordAlphabet, c) {
			t.Errorf("unexpected character %q", c)
		}
	}
}

func timeAt(sec int64) time.Time { return time.Unix(1_700_000_000+sec, 0) }
