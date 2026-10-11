package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"
)

// reqIDKey is the context key under which we stash the per-request
// correlation id. Handlers downstream of accessLog reach for it via
// requestIDFromContext.
type ctxKey int

const reqIDKey ctxKey = 1

// accessLog wraps next with request-id assignment, structured request
// logging, and a panic recovery net. One INFO line per request is
// emitted with the conventional fields (method, path, status,
// duration, remote ip, req_id) so log pipelines can group bursts
// without parsing free-form messages.
func accessLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-ID")
		if reqID == "" {
			reqID = newRequestID()
		}
		w.Header().Set("X-Request-ID", reqID)
		ctx := context.WithValue(r.Context(), reqIDKey, reqID)

		// Reuse the recorder instrumentMiddleware installed when metrics
		// are on so the request carries one wrapper, not two.
		ww, ok := w.(*statusRecorder)
		if !ok {
			ww = &statusRecorder{ResponseWriter: w, status: 200}
		}
		start := time.Now()

		defer func() {
			if rec := recover(); rec != nil {
				logger.LogAttrs(ctx, slog.LevelError, "panic in handler",
					slog.String("req_id", reqID),
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.Any("panic", rec),
				)
				if !ww.wrote {
					http.Error(ww, "internal server error", http.StatusInternalServerError)
				}
			}
			latency := time.Since(start)
			logger.LogAttrs(ctx, slog.LevelInfo, "request",
				slog.String("req_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", ww.status),
				slog.Int64("latency_ms", latency.Milliseconds()),
				slog.String("remote", clientIP(r)),
			)
		}()

		next.ServeHTTP(ww, r.WithContext(ctx))
	})
}

// requestIDFromContext returns the correlation id assigned by
// accessLog, or empty when called outside the middleware chain. Used
// by handlers that emit additional structured events ("audit") and
// want them stitched into the same trace.
func requestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(reqIDKey).(string); ok {
		return v
	}
	return ""
}

// statusRecorder captures the response status for the access log
// without buffering the body. wrote=true means at least one byte (or
// a WriteHeader call) has gone out; the panic recovery uses that to
// decide whether it's safe to send an error page.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

var _ http.Hijacker = (*statusRecorder)(nil)

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wrote {
		s.status = http.StatusOK
		s.wrote = true
	}
	return s.ResponseWriter.Write(b)
}

// Hijack lets WebSocket upgrades flow through accessLog. The proxy
// uses gorilla/websocket which calls Hijack on the ResponseWriter.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	s.wrote = true
	s.status = http.StatusSwitchingProtocols
	return h.Hijack()
}

// Flush forwards to the inner ResponseWriter when supported so
// streaming responses (file downloads) keep working.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// clientIP reports a best-effort client IP, trusting the first hop
// in X-Forwarded-For when present. net.SplitHostPort handles IPv6
// brackets correctly — a hand-rolled `LastIndexByte(':')` would chop
// `[::1]:8080` at the wrong colon.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma > 0 {
			return strings.TrimSpace(xff[:comma])
		}
		return strings.TrimSpace(xff)
	}
	if r.RemoteAddr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// newRequestID returns a 16-hex-char random id. Crypto-rand because
// req_id is used in audit lines: predictable ids would let a noisy
// neighbour spoof a correlation.
func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// rand.Read does not realistically fail; if it does, fall back
		// to a timestamp-derived id rather than crashing the request.
		return "fallback-" + time.Now().Format("20060102150405.000")
	}
	return hex.EncodeToString(b[:])
}
