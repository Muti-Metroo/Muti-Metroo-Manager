package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Regression: statusRecorder.Hijack must satisfy http.Hijacker so
// gorilla/websocket's runtime type assertion finds it. A wrong-signature
// Hijack would cause Upgrader.Upgrade to return HTTP 500, which broke
// every WebSocket-proxied feature in the UI (Shell, Ping, etc).
func TestMiddleware_AllowsWebSocketUpgrade(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade failed inside handler: %v", err)
			return
		}
		defer conn.Close()
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read: %v", err)
			return
		}
		if err := conn.WriteMessage(mt, msg); err != nil {
			t.Errorf("write: %v", err)
		}
	})

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	inst := newInstrumentation(nil)
	handler := corsMiddleware(instrumentMiddleware(inst, accessLog(logger, mux)))

	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/ws"
	u, err := url.Parse(wsURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}

	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, resp, err := dialer.Dial(u.String(), nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial: %v (http status %d)", err, status)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	mt, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.TextMessage || string(payload) != "ping" {
		t.Fatalf("unexpected echo: type=%d payload=%q", mt, payload)
	}
}
