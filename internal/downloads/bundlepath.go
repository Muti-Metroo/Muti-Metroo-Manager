package downloads

import (
	"errors"
	"os"
	"path/filepath"
)

// DefaultBundleName is the filename muti-metroo-manager looks for when
// -downloads-bundle is unset.
const DefaultBundleName = "muti-metroo-downloads-bundle.zip"

// PathStatus describes the resolved bundle path. Callers fan out on
// the status to decide whether to log, fail, or quietly disable the
// feature; check.go and cmd/manager share this so they can never
// drift on the resolution rules.
type PathStatus int

const (
	PathPresent        PathStatus = iota // bundle exists at Path
	PathAbsentImplicit                   // -downloads-bundle unset, no zip next to binary
	PathAbsentExplicit                   // -downloads-bundle set but file missing
	PathDisabled                         // -no-downloads or legacy "off" sentinel
)

// ResolvePath maps the -downloads-bundle / -no-downloads inputs onto
// a concrete filesystem path and a status. Callers don't have to
// repeat the "off" magic, the next-to-binary lookup, or the
// explicit-vs-implicit distinction — that lives here.
func ResolvePath(rawPath string, noDownloads bool) (path string, status PathStatus) {
	if noDownloads || rawPath == "off" {
		return "", PathDisabled
	}
	explicit := rawPath != ""
	path = rawPath
	if !explicit {
		exe, err := os.Executable()
		if err != nil {
			return "", PathAbsentImplicit
		}
		path = filepath.Join(filepath.Dir(exe), DefaultBundleName)
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if explicit {
				return path, PathAbsentExplicit
			}
			return path, PathAbsentImplicit
		}
		// Treat other stat errors (permission denied, etc.) as
		// "absent" but explicit so the caller logs them — operator
		// almost certainly wants to know.
		return path, PathAbsentExplicit
	}
	return path, PathPresent
}
