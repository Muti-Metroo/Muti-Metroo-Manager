package config

import (
	"os"
	"path/filepath"
	"runtime"
)

// DefaultDataDir returns the OS-appropriate location for muti-metroo-manager's
// persistent state. Earlier releases used the current working
// directory ("."), which made the SQLite file land wherever the
// supervisor happened to start the binary — surprising on launchd
// (root of /), confusing on systemd (the unit's WorkingDirectory),
// and unhelpful on multi-user Linux desktops.
//
// The macOS choice is deliberate: it matches the path the existing
// launchd unit (~/Library/Application Support/Muti-Metroo-Manager/) already
// pins for production installs, so existing operators don't get a
// migration prompt on upgrade.
//
// Failing to resolve a per-user dir falls back to "." — keeping the
// pre-PR1 behaviour rather than refusing to start.
func DefaultDataDir() string {
	switch runtime.GOOS {
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "Muti-Metroo-Manager")
		}
	case "linux", "freebsd", "openbsd", "netbsd":
		if os.Geteuid() == 0 {
			return "/var/lib/muti-metroo-manager"
		}
		if dir, err := os.UserConfigDir(); err == nil {
			return filepath.Join(dir, "muti-metroo-manager")
		}
	case "windows":
		if dir, err := os.UserConfigDir(); err == nil {
			return filepath.Join(dir, "muti-metroo-manager")
		}
	}
	return "."
}
