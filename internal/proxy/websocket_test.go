package proxy

import (
	"context"
	"net"
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
	p := httptest.NewServer(New(agent.URL, "", nil))
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
	p := httptest.NewServer(New(agent.URL, "", nil))
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
	p := httptest.NewServer(New(agent.URL, "", nil))
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

// A blackholed agent address (TCP accepted, handshake never answered)
// must fail the upgrade within the dialer's handshake timeout instead
// of parking the handler goroutine.
func TestWebSocketDialHandshakeTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	// Accept and hold: never answer the HTTP upgrade, so the relay's
	// handshake sits in ReadResponse until its timeout fires.
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close() // held open until the test binary exits
		}
	}()

	prx := New("http://"+ln.Addr().String(), "", nil)
	origTimeout := wsHandshakeTimeout
	wsHandshakeTimeout = 200 * time.Millisecond
	t.Cleanup(func() { wsHandshakeTimeout = origTimeout })
	p := httptest.NewServer(prx)
	t.Cleanup(p.Close)

	start := time.Now()
	wsURL := strings.Replace(p.URL, "http://", "ws://", 1) + "/api/proxy/ws"
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, nil)
	if err == nil {
		conn.Close()
		t.Fatal("upgrade unexpectedly succeeded against a blackholed agent")
	}
	if resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %v, want 502", resp)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("dial took %v, want ~%v (handshake timeout)", elapsed, wsHandshakeTimeout)
	}
}

// Cancelling the client request mid-dial must abort the TCP connect
// rather than leaving the handler waiting on an unroutable address.
func TestWebSocketDialContextCancellation(t *testing.T) {
	// 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — unroutable, so the TCP
	// connect stalls until something aborts it.
	prx := New("http://192.0.2.1:80", "", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/proxy/ws", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	cancel() // client already gone before the handler runs

	start := time.Now()
	rr := httptest.NewRecorder()
	prx.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("cancelled dial took %v, want a prompt abort", elapsed)
	}
}

// A close frame from the agent (code + reason, e.g. a shell exit
// status) must reach the client instead of dying as an abrupt TCP cut.
func TestWebSocketCloseFrameForwarded(t *testing.T) {
	agent, _ := startFakeAgent(t, func(conn *websocket.Conn) {
		conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shell exited"),
			time.Now().Add(time.Second))
	})
	p := httptest.NewServer(New(agent.URL, "", nil))
	t.Cleanup(p.Close)

	c := dialProxyWS(t, p.URL)
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := c.ReadMessage()
		if err == nil {
			continue
		}
		closeErr, ok := err.(*websocket.CloseError)
		if !ok {
			t.Fatalf("read error = %T %v, want *websocket.CloseError", err, err)
		}
		if closeErr.Code != websocket.CloseNormalClosure || closeErr.Text != "shell exited" {
			t.Fatalf("close = %d %q, want 1000 %q", closeErr.Code, closeErr.Text, "shell exited")
		}
		return
	}
}

// A message larger than the relay's read limit must kill the
// connection instead of being buffered in full.
func TestWebSocketReadLimitEnforced(t *testing.T) {
	agent, _ := startFakeAgent(t, func(conn *websocket.Conn) {
		conn.WriteMessage(websocket.BinaryMessage, make([]byte, wsReadLimit+1))
		// Keep the conn open so the failure comes from the relay's
		// read limit, not from the agent going away.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	p := httptest.NewServer(New(agent.URL, "", nil))
	t.Cleanup(p.Close)

	c := dialProxyWS(t, p.URL)
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			return // expected: relay dropped the oversized message
		}
	}
}
