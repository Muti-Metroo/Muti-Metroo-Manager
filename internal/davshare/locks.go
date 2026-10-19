package davshare

import (
	"time"

	"golang.org/x/net/webdav"
)

// moveLockSystem works around x/net/webdav's memLS.Confirm, which accepts
// the If-header lock tokens of a COPY or MOVE only when they match a lock
// on both the source and the destination. A client that locked a file and
// then moves it to a new, unlocked name (davfs2 does this for every rename)
// therefore always gets 412 Precondition Failed.
//
// When that check fails, Confirm retries with the tokens checked against
// the source alone and protects the destination the way the library does
// for requests without an If header: a temporary zero-depth lock that fails
// if another client holds a lock there.
type moveLockSystem struct {
	webdav.LockSystem
}

func newLockSystem() webdav.LockSystem {
	return moveLockSystem{webdav.NewMemLS()}
}

func (m moveLockSystem) Confirm(now time.Time, name0, name1 string, conditions ...webdav.Condition) (func(), error) {
	release, err := m.LockSystem.Confirm(now, name0, name1, conditions...)
	if err != webdav.ErrConfirmationFailed || name0 == "" || name1 == "" {
		return release, err
	}

	releaseSrc, err := m.LockSystem.Confirm(now, name0, "", conditions...)
	if err != nil {
		return nil, err
	}
	token, err := m.LockSystem.Create(now, webdav.LockDetails{Root: name1, Duration: -1, ZeroDepth: true})
	if err != nil {
		releaseSrc()
		// Locked by someone else: the conditions do not cover it.
		return nil, webdav.ErrConfirmationFailed
	}
	return func() {
		m.LockSystem.Unlock(now, token)
		releaseSrc()
	}, nil
}
