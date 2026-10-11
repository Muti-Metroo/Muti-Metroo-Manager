//go:build windows

package store

import (
	"os"
	"syscall"
	"unsafe"
)

// lockExclusiveNB takes an exclusive non-blocking lock via the Win32
// LockFileEx API. Without LOCKFILE_FAIL_IMMEDIATELY a second instance
// would block; we treat "would block" as the contention sentinel.
//
// We import the kernel32 API by hand rather than pulling in
// golang.org/x/sys to avoid a new module dependency for what is
// otherwise a very small platform shim. The constants and signature
// match LockFileEx as documented by Microsoft.
func lockExclusiveNB(f *os.File) error {
	const (
		LOCKFILE_EXCLUSIVE_LOCK   = 0x00000002
		LOCKFILE_FAIL_IMMEDIATELY = 0x00000001
	)
	var ol syscall.Overlapped
	r1, _, e := procLockFileEx.Call(
		uintptr(f.Fd()),
		uintptr(LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY),
		0,
		^uintptr(0),
		^uintptr(0),
		uintptr(unsafe.Pointer(&ol)),
	)
	if r1 != 0 {
		return nil
	}
	if errno, ok := e.(syscall.Errno); ok && errno == syscall.Errno(33) {
		// ERROR_LOCK_VIOLATION (33) — somebody else holds it.
		return ErrLocked
	}
	return e
}

func unlock(f *os.File) {
	var ol syscall.Overlapped
	procUnlockFileEx.Call(
		uintptr(f.Fd()),
		0,
		^uintptr(0),
		^uintptr(0),
		uintptr(unsafe.Pointer(&ol)),
	)
}

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx   = kernel32.NewProc("LockFileEx")
	procUnlockFileEx = kernel32.NewProc("UnlockFileEx")
)
