package proxy

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The Connection header is a token list: "keep-alive, Upgrade" (what a
// fronting reverse proxy may send) must still route to the WebSocket
// relay, not fall into the HTTP path and hang.
func TestIsWebSocketUpgrade(t *testing.T) {
	cases := []struct {
		name       string
		connection string
		upgrade    string
		want       bool
	}{
		{"bare upgrade", "Upgrade", "websocket", true},
		{"token list", "keep-alive, Upgrade", "websocket", true},
		{"token list lowercase", "upgrade, keep-alive", "websocket", true},
		{"upgrade value case", "Upgrade", "WebSocket", true},
		{"missing upgrade token", "keep-alive", "websocket", false},
		{"missing upgrade header", "Upgrade", "", false},
		{"token prefix is not a token", "Upgrade2", "websocket", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/proxy/ws", nil)
			if tc.connection != "" {
				r.Header.Set("Connection", tc.connection)
			}
			if tc.upgrade != "" {
				r.Header.Set("Upgrade", tc.upgrade)
			}
			if got := isWebSocketUpgrade(r); got != tc.want {
				t.Errorf("isWebSocketUpgrade(%q, %q) = %v, want %v",
					tc.connection, tc.upgrade, got, tc.want)
			}
		})
	}
}

// End to end: a tokenized Connection header must still be routed to
// the WebSocket relay (101), not fall into the HTTP proxy path. Raw
// TCP because gorilla's dialer refuses caller-set Connection headers.
func TestWebSocketUpgradeWithConnectionTokenList(t *testing.T) {
	agent, _ := startFakeAgent(t, func(conn *websocket.Conn) {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	p := httptest.NewServer(New(agent.URL, "", nil))
	t.Cleanup(p.Close)

	u, err := url.Parse(p.URL)
	if err != nil {
		t.Fatalf("parse proxy URL: %v", err)
	}
	conn, err := net.DialTimeout("tcp", u.Host, 3*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "GET /api/proxy/ws HTTP/1.1\r\nHost: %s\r\n"+
		"Connection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", u.Host)
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101 (request fell out of the WebSocket path)", resp.StatusCode)
	}
}

// Hop-by-hop headers from the agent response must not reach the
// client — neither the fixed RFC 7230 set nor headers the agent names
// in its own Connection token list.
func TestStripHopByHop(t *testing.T) {
	h := http.Header{
		"Connection":          {"keep-alive, X-Hop"},
		"Keep-Alive":          {"timeout=5"},
		"Te":                  {"trailers"},
		"Trailer":             {"X-Checksum"},
		"Transfer-Encoding":   {"chunked"},
		"Upgrade":             {"websocket"},
		"Proxy-Authenticate":  {"Basic"},
		"Proxy-Authorization": {"Basic abc"},
		"X-Hop":               {"agent-local"},
		"Content-Type":        {"application/json"},
		"X-Keep":              {"1"},
	}
	stripHopByHop(h)
	for _, k := range []string{
		"Connection", "Keep-Alive", "Te", "Trailer", "Transfer-Encoding",
		"Upgrade", "Proxy-Authenticate", "Proxy-Authorization", "X-Hop",
	} {
		if v := h.Get(k); v != "" {
			t.Errorf("%s survived stripping: %q", k, v)
		}
	}
	if h.Get("Content-Type") != "application/json" || h.Get("X-Keep") != "1" {
		t.Errorf("end-to-end headers were stripped: %v", h)
	}
}
