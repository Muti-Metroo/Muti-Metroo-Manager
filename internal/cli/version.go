package cli

import (
	"fmt"
	"io"
	"runtime"
	"runtime/debug"
)

// printVersion is the body of the version / -version / --version / -V
// commands. The output is one short paragraph designed to be safe to
// paste into an incident ticket — it identifies the binary, the
// commit, the Go toolchain, and (when available) the VCS state at
// build time.
func printVersion(build Build, w io.Writer) {
	fmt.Fprintf(w, "muti-metroo-manager %s\n", nonEmpty(build.Version, "dev"))
	fmt.Fprintf(w, "  commit:  %s\n", nonEmpty(build.Commit, vcsRevision()))
	fmt.Fprintf(w, "  go:      %s\n", nonEmpty(build.GoVer, runtime.Version()))
	fmt.Fprintf(w, "  os/arch: %s/%s\n", runtime.GOOS, runtime.GOARCH)
}

// vcsRevision walks debug.BuildInfo for a vcs.revision setting,
// emitted by `go build` since 1.18 when the source tree is a git
// checkout. Returns the empty string when unavailable so callers can
// fall back to a literal placeholder.
func vcsRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	rev, mod := "", ""
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			mod = s.Value
		}
	}
	if rev == "" {
		return ""
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	if mod == "true" {
		rev += "-dirty"
	}
	return rev
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
