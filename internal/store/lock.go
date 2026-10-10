package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
)

// InstanceLock is the kernel-held lock on <data-dir>/muti-metroo-manager.lock
// that prevents two muti-metroo-manager processes from sharing one SQLite DB.
// flock(2) on Unix, LockFileEx on Windows — both are auto-released
// on process exit, so a stale lock file never blocks a restart.
type InstanceLock struct {
	path string
	f    *os.File
}

// AcquireInstanceLock takes an exclusive lock on <dataDir>/muti-metroo-manager.lock.
// The lock file is left on disk between runs; only its kernel-level
// lock state is authoritative. The current PID is written into it for
// human-readable forensics ("which process holds it?").
//
// ErrLocked (wrap-matched via errors.Is) is returned when another
// process already holds the lock, so callers can distinguish
// "permission denied / disk full" from "another instance is running."
func AcquireInstanceLock(dataDir string) (*InstanceLock, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	path := filepath.Join(dataDir, "muti-metroo-manager.lock")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock %s: %w", path, err)
	}
	if err := lockExclusiveNB(f); err != nil {
		other := readPID(f)
		f.Close()
		if errors.Is(err, ErrLocked) {
			if other != "" {
				return nil, fmt.Errorf("%w: held by pid %s (%s)", ErrLocked, other, path)
			}
			return nil, fmt.Errorf("%w: %s", ErrLocked, path)
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	// Best effort: write our pid for ps-style forensics.
	f.Truncate(0)
	f.Seek(0, io.SeekStart)
	fmt.Fprintln(f, os.Getpid())
	return &InstanceLock{path: path, f: f}, nil
}

// ErrLocked is returned by AcquireInstanceLock when another process
// already holds the lock. The platform shims also return it directly
// to signal contention vs a real OS error.
var ErrLocked = errors.New("another muti-metroo-manager instance is already running")

// Release drops the lock and closes the file. The lock file itself
// stays on disk so subsequent runs reuse the same inode.
func (l *InstanceLock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	unlock(l.f)
	err := l.f.Close()
	l.f = nil
	return err
}

// Path returns the lock file's path; useful for log messages.
func (l *InstanceLock) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

func readPID(f *os.File) string {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return ""
	}
	buf := make([]byte, 32)
	n, _ := f.Read(buf)
	if n == 0 {
		return ""
	}
	s := string(buf[:n])
	for i, c := range s {
		if c == '\n' || c == '\r' || c == ' ' {
			s = s[:i]
			break
		}
	}
	if _, err := strconv.Atoi(s); err != nil {
		return ""
	}
	return s
}
