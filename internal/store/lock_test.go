package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLockAcquireAndRelease(t *testing.T) {
	dir := t.TempDir()
	l, err := AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if l.Path() != filepath.Join(dir, "muti-metroo-manager.lock") {
		t.Errorf("Path() = %q", l.Path())
	}
	if err := l.Release(); err != nil {
		t.Errorf("release: %v", err)
	}
	// Lock file should remain on disk so the next acquire reuses the
	// same inode.
	if _, err := os.Stat(filepath.Join(dir, "muti-metroo-manager.lock")); err != nil {
		t.Errorf("lock file missing after release: %v", err)
	}
}

func TestLockContention(t *testing.T) {
	dir := t.TempDir()
	first, err := AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer first.Release()

	// Second acquire from the same process must fail with ErrLocked.
	// (On most Unixes flock is per-fd, so this is exercising the
	// "another open file descriptor" path.)
	_, err = AcquireInstanceLock(dir)
	if err == nil {
		t.Fatal("second acquire should have failed")
	}
	if !errors.Is(err, ErrLocked) {
		t.Errorf("error = %v, want ErrLocked wrapped", err)
	}
}

func TestLockReleaseAllowsReacquire(t *testing.T) {
	dir := t.TempDir()
	first, err := AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	second, err := AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("reacquire: %v", err)
	}
	second.Release()
}
