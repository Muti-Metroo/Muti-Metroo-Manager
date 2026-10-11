package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

var testUpgrader = websocket.Upgrader{}

// startFakeAgent runs a websocket server whose behaviour per connection
// is driven by serve. Each accepted connection reports its termination
// on the returned channel.
func startFakeAgent(t *testing.T, serve func(conn *websocket.Conn)) (*httptest.Server, <-chan struct{}) {
	t.Helper()
	closed := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serve(conn)
		conn.Close()
		closed <- struct{}{}
	}))
	t.Cleanup(srv.Close)
	return srv, closed
}

func dialProxyWS(t *testing.T, proxyURL string) *websocket.Conn {
	t.Helper()
	wsURL := strings.Replace(proxyURL, "http://", "ws://", 1) + "/api/proxy/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	return conn
}

func TestWebSocketEchoRoundTrip(t *testing.T) {
	agent, _ := startFakeAgent(t, func(conn *websocket.Conn) {
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if conn.WriteMessage(mt, msg) != nil {
				return
			}
		}
	})
	p := httptest.NewServer(New(agent.URL, ""))
	t.Cleanup(p.Close)

	c := dialProxyWS(t, p.URL)
	defer c.Close()
	if err := c.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(msg) != "ping" {
		t.Fatalf("echo = %q, want ping", msg)
	}
}

// When the client disappears, the relay must tear down the agent-side
// connection instead of parking forever on a silent agent.
func TestWebSocketClientDisconnectClosesAgentSide(t *testing.T) {
	agent, agentClosed := startFakeAgent(t, func(conn *websocket.Conn) {
		// Silent agent: read until the connection dies.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	p := httptest.NewServer(New(agent.URL, ""))
	t.Cleanup(p.Close)

	c := dialProxyWS(t, p.URL)
	c.Close()

	select {
	case <-agentClosed:
	case <-time.After(3 * time.Second):
		t.Fatal("agent-side connection was not closed after client disconnect")
	}
}

// When the agent disappears, the relay must close the client-side
// connection instead of leaving the client reading a dead socket.
func TestWebSocketAgentDisconnectClosesClientSide(t *testing.T) {
	agent, _ := startFakeAgent(t, func(conn *websocket.Conn) {
		// Die immediately without reading anything.
	})
	p := httptest.NewServer(New(agent.URL, ""))
	t.Cleanup(p.Close)

	c := dialProxyWS(t, p.URL)
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			return // expected: connection closed by the relay
		}
	}
}
