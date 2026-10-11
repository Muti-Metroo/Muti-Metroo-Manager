package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Cross-site WebSocket attempts must be refused: the browser attaches
// the manager's session cookie to any upgrade it can trick a page into
// opening, so a permissive CheckOrigin would turn the manager into an
// open relay. Same-origin and Origin-less (non-browser) upgrades pass.
func TestWebSocketCheckOrigin(t *testing.T) {
	agent, _ := startFakeAgent(t, func(conn *websocket.Conn) {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	p := httptest.NewServer(New(agent.URL, "", nil))
	t.Cleanup(p.Close)

	wsURL := strings.Replace(p.URL, "http://", "ws://", 1) + "/api/proxy/ws"
	host := strings.TrimPrefix(p.URL, "http://")

	cases := []struct {
		name   string
		origin string
		wantOK bool
	}{
		{"no origin header", "", true},
		{"same origin", "http://" + host, true},
		{"cross origin", "http://evil.example", false},
		{"cross origin same host different port", "http://" + host[:strings.LastIndex(host, ":")] + ":1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hdr := http.Header{}
			if tc.origin != "" {
				hdr.Set("Origin", tc.origin)
			}
			dialer := websocket.Dialer{HandshakeTimeout: 3 * time.Second}
			conn, resp, err := dialer.Dial(wsURL, hdr)
			if tc.wantOK {
				if err != nil {
					t.Fatalf("dial: %v", err)
				}
				conn.Close()
				return
			}
			if err == nil {
				conn.Close()
				t.Fatal("cross-origin upgrade unexpectedly succeeded")
			}
			if resp == nil || resp.StatusCode != http.StatusForbidden {
				t.Fatalf("status = %v, want 403", resp)
			}
		})
	}
}
