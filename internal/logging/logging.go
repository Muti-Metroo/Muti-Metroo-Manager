// Package logging configures the process-wide slog handler from the
// -log-level / -log-format flags so banner, access log, audit, and
// proxy errors share one format.
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// Format selects the output encoding. JSON is one event per line;
// Text is the slog default — readable in journalctl, key=value pairs.
type Format int

const (
	FormatText Format = iota
	FormatJSON
)

// ParseFormat turns a CLI string ("text"/"json") into a Format. Empty
// input maps to FormatText so an unset flag does the safest thing.
func ParseFormat(s string) (Format, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "text":
		return FormatText, true
	case "json":
		return FormatJSON, true
	}
	return FormatText, false
}

// ParseLevel turns a CLI string into an slog.Level. Unknown values
// fall back to slog.LevelInfo and report ok=false so the caller can
// surface a warning.
func ParseLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "info":
		return slog.LevelInfo, true
	case "debug":
		return slog.LevelDebug, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	}
	return slog.LevelInfo, false
}

// Configure builds an slog.Logger writing to w, sets it as the
// process-wide default (slog.SetDefault), and rewires the legacy
// log.Default() so that pre-PR4 log.Printf callers fall through to
// slog at INFO. Returning the logger lets callers use it directly
// when they want to add scope-specific attributes.
func Configure(w io.Writer, level slog.Level, format Format) *slog.Logger {
	if w == nil {
		w = os.Stderr
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	switch format {
	case FormatJSON:
		h = slog.NewJSONHandler(w, opts)
	default:
		h = slog.NewTextHandler(w, opts)
	}
	logger := slog.New(h)
	slog.SetDefault(logger)
	return logger
}
