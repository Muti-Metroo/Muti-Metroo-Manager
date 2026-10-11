package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestAuthMiddleware_NoCredentials(t *testing.T) {
	h := authMiddleware("secret", okHandler())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := rec.Header().Get("WWW-Authenticate"); got != managerAuthRealm {
		t.Errorf("WWW-Authenticate = %q, want %q", got, managerAuthRealm)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body["error_code"] != "manager_auth_required" {
		t.Errorf("error_code = %q, want manager_auth_required", body["error_code"])
	}
}

func TestAuthMiddleware_CredentialCarriers(t *testing.T) {
	cases := []struct {
		name string
		req  func() *http.Request
		want int
	}{
		{"bearer", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
			r.Header.Set("Authorization", "Bearer secret")
			return r
		}, http.StatusOK},
		{"bearer wrong", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
			r.Header.Set("Authorization", "Bearer wrong")
			return r
		}, http.StatusUnauthorized},
		{"cookie", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
			r.AddCookie(&http.Cookie{Name: authCookieName, Value: "secret"})
			return r
		}, http.StatusOK},
		{"cookie wrong", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
			r.AddCookie(&http.Cookie{Name: authCookieName, Value: "wrong"})
			return r
		}, http.StatusUnauthorized},
		{"query token (websocket)", func() *http.Request {
			return httptest.NewRequest(http.MethodGet, "/api/proxy/ws?token=secret", nil)
		}, http.StatusOK},
		{"query token wrong", func() *http.Request {
			return httptest.NewRequest(http.MethodGet, "/api/proxy/ws?token=wrong", nil)
		}, http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := authMiddleware("secret", okHandler())
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, tc.req())
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

// An empty token disables the gate entirely — the loopback /
// -insecure-no-auth posture enforced by cmd/manager.
func TestAuthMiddleware_DisabledWhenTokenEmpty(t *testing.T) {
	h := authMiddleware("", okHandler())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestLoginHandler_SetsCookieOnValidToken(t *testing.T) {
	h := loginHandler("secret")
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"token":"secret"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("got %d cookies, want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != authCookieName || c.Value != "secret" {
		t.Errorf("cookie = %v, want %s=secret", c, authCookieName)
	}
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie flags: HttpOnly=%v SameSite=%v", c.HttpOnly, c.SameSite)
	}
	if c.Secure {
		t.Error("cookie must not be Secure on a plaintext request")
	}
}

func TestLoginHandler_SecureCookieBehindTLSProxy(t *testing.T) {
	h := loginHandler("secret")
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"token":"secret"}`))
	r.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure {
		t.Fatalf("want a single Secure cookie, got %v", cookies)
	}
}

func TestLoginHandler_RejectsWrongToken(t *testing.T) {
	h := loginHandler("secret")
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"token":"wrong"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("no cookie must be set on a failed login")
	}
	if got := rec.Header().Get("WWW-Authenticate"); got != managerAuthRealm {
		t.Errorf("WWW-Authenticate = %q, want %q", got, managerAuthRealm)
	}
}

func TestLoginHandler_MethodNotAllowed(t *testing.T) {
	h := loginHandler("secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/auth/login", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestBindsLoopbackOnly(t *testing.T) {
	cases := map[string]bool{
		":3000":            false, // wildcard bind
		"0.0.0.0:3000":     false,
		"[::]:3000":        false,
		"192.168.1.5:3000": false,
		"example.com:3000": false,
		"127.0.0.1:3000":   true,
		"127.0.1.2:3000":   true,
		"[::1]:3000":       true,
		"localhost:3000":   true,
		"LOCALHOST:3000":   true,
	}
	for addr, want := range cases {
		if got := BindsLoopbackOnly(addr); got != want {
			t.Errorf("BindsLoopbackOnly(%q) = %v, want %v", addr, got, want)
		}
	}
}
