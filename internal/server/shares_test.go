package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/store"
)

const shareTestAgent = "0123456789abcdef0123456789abcdef"

// fakeShareAgent answers file/browse stat for /srv/files (a directory)
// and /srv/files/a.txt (a file); everything else is not found.
func fakeShareAgent(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agents/"+shareTestAgent+"/file/browse" {
			http.Error(w, "failed to send request: no route to agent", http.StatusBadGateway)
			return
		}
		var in struct {
			Action string `json:"action"`
			Path   string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case in.Path == "/srv/files":
			io.WriteString(w, `{"path":"/srv/files","entry":{"name":"files","size":0,"mode":"0755","mod_time":"2026-01-01T00:00:00Z","is_dir":true},"entries":[]}`)
		case in.Path == "/srv/files/a.txt":
			io.WriteString(w, `{"path":"/srv/files/a.txt","entry":{"name":"a.txt","size":1,"mode":"0644","mod_time":"2026-01-01T00:00:00Z","is_dir":false}}`)
		case strings.HasPrefix(in.Path, "/etc"):
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":"path not in allowed list: /etc","error_code":"not_allowed"}`)
		default:
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":"path not found","error_code":"not_found"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

type shareServer struct {
	url   string
	token string
}

func newShareServer(t *testing.T) shareServer {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	agent := fakeShareAgent(t)
	srv, _ := New(Options{
		Addr:      "127.0.0.1:0",
		AgentURL:  agent.URL,
		Store:     st,
		AuthToken: "manager-token",
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	ts := httptest.NewServer(srv.Handler)
	t.Cleanup(ts.Close)
	return shareServer{url: ts.URL, token: "manager-token"}
}

func (s shareServer) api(t *testing.T, method, path, body string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, s.url+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func (s shareServer) dav(t *testing.T, path, user, pass string) int {
	t.Helper()
	req, _ := http.NewRequest("PROPFIND", s.url+path, nil)
	req.Header.Set("Depth", "0")
	if user != "" {
		req.SetBasicAuth(user, pass)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

type createdShare struct {
	Share struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		Username  string `json:"username"`
		ReadOnly  bool   `json:"read_only"`
		Enabled   bool   `json:"enabled"`
		MountPath string `json:"mount_path"`
	} `json:"share"`
	Password     string `json:"password"`
	LoopbackOnly bool   `json:"loopback_only"`
}

// The share API stays behind the manager token while /dav/ is gated by
// per-share Basic auth only: neither credential opens the other door.
func TestShareRoutesAuthScoping(t *testing.T) {
	s := newShareServer(t)

	for _, p := range []string{"/api/shares", "/api/shares/1"} {
		resp, err := http.Get(s.url + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") != managerAuthRealm {
			t.Errorf("%s without token = %d, want manager 401", p, resp.StatusCode)
		}
	}

	_, body := s.api(t, "POST", "/api/shares", `{"name":"files","agent_id":"`+shareTestAgent+`","remote_path":"/srv/files"}`)
	var c createdShare
	json.Unmarshal(body, &c)

	if code := s.dav(t, "/dav/files/", "", ""); code != http.StatusUnauthorized {
		t.Errorf("/dav without credentials = %d, want 401", code)
	}
	// The manager token is not a share credential, as Basic or Bearer.
	if code := s.dav(t, "/dav/files/", "files", s.token); code != http.StatusUnauthorized {
		t.Errorf("/dav with manager token as password = %d, want 401", code)
	}
	req, _ := http.NewRequest("PROPFIND", s.url+"/dav/files/", nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("/dav with manager bearer = %d, want 401", resp.StatusCode)
	}
	// And share credentials do not open /api.
	req, _ = http.NewRequest("GET", s.url+"/api/shares", nil)
	req.SetBasicAuth("files", c.Password)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("/api with share credentials = %d, want 401", resp.StatusCode)
	}

	if code := s.dav(t, "/dav/files/", "files", c.Password); code != http.StatusMultiStatus {
		t.Errorf("/dav with share credentials = %d, want 207", code)
	}
}

func TestShareAPICRUD(t *testing.T) {
	s := newShareServer(t)

	resp, body := s.api(t, "POST", "/api/shares", `{"name":"files","agent_id":"`+strings.ToUpper(shareTestAgent)+`","remote_path":"/srv/files"}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d %s", resp.StatusCode, body)
	}
	if strings.Contains(string(body), "password_hash") || strings.Contains(string(body), "$2a$") {
		t.Errorf("create response leaks the hash: %s", body)
	}
	var c createdShare
	json.Unmarshal(body, &c)
	if c.Password == "" || c.Share.ID == 0 || !c.Share.ReadOnly || !c.Share.Enabled ||
		c.Share.Username != "files" || c.Share.MountPath != "/dav/files/" || !c.LoopbackOnly {
		t.Errorf("create = %+v", c)
	}

	// A supplied password is accepted and not echoed back.
	resp, body = s.api(t, "POST", "/api/shares", `{"name":"mine","agent_id":"`+shareTestAgent+`","remote_path":"/srv/files","read_only":false,"username":"bob","password":"long-enough"}`)
	var mine createdShare
	json.Unmarshal(body, &mine)
	if resp.StatusCode != http.StatusCreated || mine.Password != "" || mine.Share.ReadOnly {
		t.Errorf("create with password = %d %s", resp.StatusCode, body)
	}
	if code := s.dav(t, "/dav/mine/", "bob", "long-enough"); code != http.StatusMultiStatus {
		t.Errorf("supplied password does not authenticate: %d", code)
	}

	bad := map[string]struct {
		body string
		want int
	}{
		"duplicate":     {`{"name":"files","agent_id":"` + shareTestAgent + `","remote_path":"/srv/files"}`, http.StatusConflict},
		"bad name":      {`{"name":"Bad Name","agent_id":"` + shareTestAgent + `","remote_path":"/srv/files"}`, http.StatusBadRequest},
		"short pass":    {`{"name":"x1","agent_id":"` + shareTestAgent + `","remote_path":"/srv/files","password":"short"}`, http.StatusBadRequest},
		"missing path":  {`{"name":"x2","agent_id":"` + shareTestAgent + `","remote_path":"/srv/nope"}`, http.StatusBadRequest},
		"file not dir":  {`{"name":"x3","agent_id":"` + shareTestAgent + `","remote_path":"/srv/files/a.txt"}`, http.StatusBadRequest},
		"not allowed":   {`{"name":"x4","agent_id":"` + shareTestAgent + `","remote_path":"/etc"}`, http.StatusBadRequest},
		"bad agent id":  {`{"name":"x5","agent_id":"abc","remote_path":"/srv/files"}`, http.StatusBadRequest},
		"invalid JSON":  {`{`, http.StatusBadRequest},
		"unknown agent": {`{"name":"x6","agent_id":"ffffffffffffffffffffffffffffffff","remote_path":"/srv/files"}`, http.StatusBadGateway},
	}
	for name, tc := range bad {
		if resp, body := s.api(t, "POST", "/api/shares", tc.body); resp.StatusCode != tc.want {
			t.Errorf("%s: status = %d %s, want %d", name, resp.StatusCode, body, tc.want)
		}
	}

	resp, body = s.api(t, "GET", "/api/shares", "")
	var list struct {
		Shares       []map[string]any `json:"shares"`
		LoopbackOnly bool             `json:"loopback_only"`
	}
	json.Unmarshal(body, &list)
	if resp.StatusCode != http.StatusOK || len(list.Shares) != 2 || !list.LoopbackOnly {
		t.Errorf("list = %d %s", resp.StatusCode, body)
	}
	if strings.Contains(string(body), "password") {
		t.Errorf("list leaks password data: %s", body)
	}

	id := itoa64(c.Share.ID)
	// Rotate: the new password works, the old one stops working.
	resp, body = s.api(t, "PATCH", "/api/shares/"+id, `{"rotate_password":true}`)
	var rot createdShare
	json.Unmarshal(body, &rot)
	if resp.StatusCode != http.StatusOK || rot.Password == "" || rot.Password == c.Password {
		t.Fatalf("rotate = %d %s", resp.StatusCode, body)
	}
	if code := s.dav(t, "/dav/files/", "files", c.Password); code != http.StatusUnauthorized {
		t.Errorf("old password after rotate = %d, want 401", code)
	}
	if code := s.dav(t, "/dav/files/", "files", rot.Password); code != http.StatusMultiStatus {
		t.Errorf("new password after rotate = %d, want 207", code)
	}

	// Disable: 404 on /dav even with valid credentials.
	if resp, body = s.api(t, "PATCH", "/api/shares/"+id, `{"enabled":false,"read_only":false}`); resp.StatusCode != http.StatusOK ||
		strings.Contains(string(body), `"password"`) {
		t.Errorf("disable = %d %s", resp.StatusCode, body)
	}
	if code := s.dav(t, "/dav/files/", "files", rot.Password); code != http.StatusNotFound {
		t.Errorf("disabled share = %d, want 404", code)
	}

	if resp, _ = s.api(t, "PATCH", "/api/shares/999", `{"enabled":true}`); resp.StatusCode != http.StatusNotFound {
		t.Errorf("patch unknown = %d, want 404", resp.StatusCode)
	}
	if resp, _ = s.api(t, "DELETE", "/api/shares/"+id, ""); resp.StatusCode != http.StatusNoContent {
		t.Errorf("delete = %d", resp.StatusCode)
	}
	if resp, _ = s.api(t, "DELETE", "/api/shares/"+id, ""); resp.StatusCode != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", resp.StatusCode)
	}
	if resp, _ = s.api(t, "DELETE", "/api/shares/abc", ""); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("delete bad id = %d, want 400", resp.StatusCode)
	}
}

func itoa64(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
