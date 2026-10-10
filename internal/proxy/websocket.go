package proxy

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
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

	// Dial agent
	dialer := websocket.Dialer{
		TLSClientConfig: p.client.Transport.(*http.Transport).TLSClientConfig,
		Subprotocols:    clientSubprotocols,
	}
	var dialHeaders http.Header
	if p.agentToken != "" {
		dialHeaders = http.Header{"Authorization": {"Bearer " + p.agentToken}}
	}
	agentConn, dialResp, err := dialer.Dial(targetURL, dialHeaders)
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

	done := make(chan struct{})
	logger := slog.Default()
	logErr := func(direction string, err error) {
		logger.Debug("ws relay", slog.String("dir", direction), slog.String("path", agentPath), slog.String("err", err.Error()))
	}

	// Agent → Client
	go func() {
		defer close(done)
		for {
			msgType, msg, err := agentConn.ReadMessage()
			if err != nil {
				logErr("agent->client read", err)
				return
			}
			if err := clientConn.WriteMessage(msgType, msg); err != nil {
				logErr("agent->client write", err)
				return
			}
		}
	}()

	// Client → Agent
	for {
		msgType, msg, err := clientConn.ReadMessage()
		if err != nil {
			logErr("client->agent read", err)
			break
		}
		if err := agentConn.WriteMessage(msgType, msg); err != nil {
			logErr("client->agent write", err)
			break
		}
	}

	<-done
}
