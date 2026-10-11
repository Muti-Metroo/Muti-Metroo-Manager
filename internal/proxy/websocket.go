package proxy

import (
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocket relay tuning. wsPingPeriod must stay well below wsPongWait
// so a healthy peer pongs before its read deadline expires.
const (
	wsReadLimit    = 4 << 20 // 4MB — far above shell output / ICMP payloads
	wsPongWait     = 60 * time.Second
	wsPingPeriod   = 30 * time.Second
	wsWriteTimeout = 10 * time.Second
)

// wsHandshakeTimeout bounds the agent WebSocket connect+handshake. A
// var (not a const) so tests can shorten it without waiting out the
// production value.
var wsHandshakeTimeout = 15 * time.Second

var upgrader = websocket.Upgrader{
	// Same-origin policy for the browser-facing upgrade: accept
	// requests with no Origin header (curl, agents, other non-browser
	// clients) and requests whose Origin host matches the request
	// Host. Anything else is a cross-site WebSocket attempt — the
	// browser would send the manager's session cookie along, so a
	// permissive check here would let any visited page drive the
	// agent API through the manager.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return strings.EqualFold(u.Host, r.Host)
	},
}

// handleWebSocket upgrades the client connection, dials the agent,
// and relays frames bidirectionally.
func (p *Proxy) handleWebSocket(w http.ResponseWriter, r *http.Request, agentPath string) {
	// Build agent ws:// URL
	agentWS := strings.Replace(p.agentURL, "http://", "ws://", 1)
	agentWS = strings.Replace(agentWS, "https://", "wss://", 1)
	targetURL := agentWS + agentPath
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	// Forward subprotocols from client request
	clientSubprotocols := websocket.Subprotocols(r)

	// Dial agent. DialContext ties the TCP connect to the client
	// request context (a client that hangs up mid-connect aborts the
	// dial); HandshakeTimeout then bounds the connect+handshake as a
	// whole, so a blackholed agent address can't park the handler
	// goroutine forever.
	dialer := websocket.Dialer{
		HandshakeTimeout: wsHandshakeTimeout,
		NetDialContext:   (&net.Dialer{Timeout: wsHandshakeTimeout}).DialContext,
		TLSClientConfig:  p.client.Transport.(*http.Transport).TLSClientConfig,
		Subprotocols:     clientSubprotocols,
	}
	var dialHeaders http.Header
	if p.agentToken != "" {
		dialHeaders = http.Header{"Authorization": {"Bearer " + p.agentToken}}
	}
	agentConn, dialResp, err := dialer.DialContext(r.Context(), targetURL, dialHeaders)
	if err != nil {
		if dialResp != nil && dialResp.StatusCode == http.StatusUnauthorized {
			w.Header().Set("WWW-Authenticate", `Bearer realm="muti-metroo"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		http.Error(w, "failed to connect to agent websocket: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer agentConn.Close()

	// Upgrade client connection, echoing the subprotocol negotiated with the agent
	respHeader := http.Header{}
	if negotiated := agentConn.Subprotocol(); negotiated != "" {
		respHeader.Set("Sec-WebSocket-Protocol", negotiated)
	}
	clientConn, err := upgrader.Upgrade(w, r, respHeader)
	if err != nil {
		return
	}
	defer clientConn.Close()

	// A single huge message would otherwise be buffered in full before
	// the relay sees it; cap both directions.
	agentConn.SetReadLimit(wsReadLimit)
	clientConn.SetReadLimit(wsReadLimit)

	// Dead-peer detection: each side gets a read deadline that only
	// pongs extend. The ping loops below originate the pings; gorilla
	// answers inbound pings (from the browser or the agent) itself, and
	// WriteControl is safe to call concurrently with the relay's
	// WriteMessage, so the single-reader/single-writer rule holds.
	for _, conn := range []*websocket.Conn{agentConn, clientConn} {
		conn.SetReadDeadline(time.Now().Add(wsPongWait))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(wsPongWait))
		})
	}
	pingDone := make(chan struct{})
	defer close(pingDone)
	go pingLoop(agentConn, pingDone)
	go pingLoop(clientConn, pingDone)

	done := make(chan struct{})
	logger := slog.Default()
	logErr := func(direction string, err error) {
		logger.Debug("ws relay", slog.String("dir", direction), slog.String("path", agentPath), slog.String("err", err.Error()))
	}

	// Agent → Client. Closing clientConn on exit unblocks the
	// client→agent read loop below when the agent goes away first.
	go func() {
		defer close(done)
		defer clientConn.Close()
		relay(agentConn, clientConn, "agent->client", logErr)
	}()

	// Client → Agent
	relay(clientConn, agentConn, "client->agent", logErr)

	// Closing agentConn unblocks the agent→client goroutine's read when
	// the client went away first; without this the handler parks on
	// <-done forever and leaks both connections. The deferred Closes
	// above make the second close a harmless no-op error.
	agentConn.Close()
	<-done
}

// relay copies messages from src to dst until either side fails. A
// close frame read from src is forwarded to dst (code + reason) before
// tearing down, so e.g. a shell exit status survives the relay instead
// of dying as an abrupt TCP close.
func relay(src, dst *websocket.Conn, direction string, logErr func(string, error)) {
	for {
		msgType, msg, err := src.ReadMessage()
		if err != nil {
			if closeErr, ok := err.(*websocket.CloseError); ok {
				dst.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(closeErr.Code, closeErr.Text),
					time.Now().Add(wsWriteTimeout))
			}
			logErr(direction+" read", err)
			return
		}
		if err := dst.WriteMessage(msgType, msg); err != nil {
			logErr(direction+" write", err)
			return
		}
	}
}

// pingLoop originates pings on conn until done closes. A failed ping
// means the peer is gone; closing the conn unblocks the relay's read
// loop instead of waiting out the read deadline.
func pingLoop(conn *websocket.Conn, done <-chan struct{}) {
	ticker := time.NewTicker(wsPingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteTimeout)); err != nil {
				conn.Close()
				return
			}
		}
	}
}
