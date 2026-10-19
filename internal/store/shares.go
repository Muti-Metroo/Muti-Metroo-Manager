package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// Share is a WebDAV file share: a folder on one agent that the manager
// serves at /dav/{Name}/ behind per-share HTTP Basic auth. PasswordHash
// is a bcrypt hash and never travels over the API.
type Share struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	AgentID      string    `json:"agent_id"`
	RemotePath   string    `json:"remote_path"`
	ReadOnly     bool      `json:"read_only"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Enabled      bool      `json:"enabled"`
	CreatedAt    time.Time `json:"created_at"`
}

// ShareUpdate carries the mutable share fields; nil means "leave as is".
type ShareUpdate struct {
	Enabled      *bool
	ReadOnly     *bool
	PasswordHash *string
}

// ErrInvalidShare is returned when a share field fails validation.
// Handlers map this to 400.
var ErrInvalidShare = errors.New("invalid share")

// ErrShareExists is returned when a share name is already taken.
// Handlers map this to 409.
var ErrShareExists = errors.New("share name already exists")

// ErrShareNotFound is returned for an unknown share id or name.
// Handlers map this to 404.
var ErrShareNotFound = errors.New("share not found")

const (
	maxShareNameLen     = 64
	maxShareUsernameLen = 64
	maxSharePathLen     = 4096
)

const shareColumns = `id, name, agent_id, remote_path, read_only, username, password_hash, enabled, created_at`

// ListShares returns every share ordered by name.
func (s *Store) ListShares() ([]Share, error) {
	rows, err := s.db.Query(`SELECT ` + shareColumns + ` FROM file_shares ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Share{}
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

// GetShare returns the share with the given id, or ErrShareNotFound.
func (s *Store) GetShare(id int64) (Share, error) {
	return scanShare(s.db.QueryRow(`SELECT `+shareColumns+` FROM file_shares WHERE id = ?`, id))
}

// GetShareByName returns the share with the given name, or
// ErrShareNotFound. The WebDAV gateway calls this on every request so
// edits from the API take effect without a restart.
func (s *Store) GetShareByName(name string) (Share, error) {
	return scanShare(s.db.QueryRow(`SELECT `+shareColumns+` FROM file_shares WHERE name = ?`, name))
}

// NormalizeShare trims the user-supplied text fields and lower-cases
// the agent id. Callers run it on input before ValidateShare and
// CreateShare, which take the fields as given.
func NormalizeShare(sh Share) Share {
	sh.Name = strings.TrimSpace(sh.Name)
	sh.AgentID = strings.ToLower(strings.TrimSpace(sh.AgentID))
	sh.RemotePath = strings.TrimSpace(sh.RemotePath)
	sh.Username = strings.TrimSpace(sh.Username)
	return sh
}

// CreateShare validates and inserts sh (see NormalizeShare). ID and
// CreatedAt are assigned here; the returned Share carries both.
func (s *Store) CreateShare(sh Share) (Share, error) {
	if err := validateRow(sh); err != nil {
		return Share{}, err
	}
	now := time.Now()
	res, err := s.db.Exec(`
		INSERT INTO file_shares(name, agent_id, remote_path, read_only, username, password_hash, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, sh.Name, sh.AgentID, sh.RemotePath, boolInt(sh.ReadOnly), sh.Username, sh.PasswordHash,
		boolInt(sh.Enabled), now.Unix(), now.Unix())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return Share{}, fmt.Errorf("%w: %q", ErrShareExists, sh.Name)
		}
		return Share{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Share{}, err
	}
	return s.GetShare(id)
}

// UpdateShare applies the non-nil fields of u to share id and returns
// the updated row.
func (s *Store) UpdateShare(id int64, u ShareUpdate) (Share, error) {
	sh, err := s.GetShare(id)
	if err != nil {
		return Share{}, err
	}
	if u.Enabled != nil {
		sh.Enabled = *u.Enabled
	}
	if u.ReadOnly != nil {
		sh.ReadOnly = *u.ReadOnly
	}
	if u.PasswordHash != nil {
		sh.PasswordHash = *u.PasswordHash
	}
	if err := validateRow(sh); err != nil {
		return Share{}, err
	}
	_, err = s.db.Exec(`
		UPDATE file_shares SET read_only = ?, enabled = ?, password_hash = ?, updated_at = ? WHERE id = ?
	`, boolInt(sh.ReadOnly), boolInt(sh.Enabled), sh.PasswordHash, time.Now().Unix(), id)
	if err != nil {
		return Share{}, err
	}
	return sh, nil
}

// DeleteShare removes share id; ErrShareNotFound when it does not exist.
func (s *Store) DeleteShare(id int64) error {
	res, err := s.db.Exec(`DELETE FROM file_shares WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrShareNotFound
	}
	return nil
}

// IsShareName reports whether v is a valid share name: a lower-case,
// URL-safe slug [a-z0-9][a-z0-9_-]{0,63}. Lower-case only so a mount
// URL can't differ from the stored name by case alone.
func IsShareName(v string) bool {
	if len(v) == 0 || len(v) > maxShareNameLen {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		alnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if !alnum && (i == 0 || (c != '-' && c != '_')) {
			return false
		}
	}
	return true
}

// ValidateShare checks every field CreateShare stores except the
// password hash, so a caller can reject a bad request before doing
// anything expensive (such as hashing the password).
func ValidateShare(sh Share) error {
	if !IsShareName(sh.Name) {
		return fmt.Errorf("%w: name must be 1-%d characters of a-z, 0-9, '-' or '_', starting with a letter or digit",
			ErrInvalidShare, maxShareNameLen)
	}
	if !isAgentID(sh.AgentID) {
		return fmt.Errorf("%w: agent_id must be a 32-character hex agent id", ErrInvalidShare)
	}
	if sh.RemotePath == "" || len(sh.RemotePath) > maxSharePathLen || strings.ContainsRune(sh.RemotePath, 0) {
		return fmt.Errorf("%w: remote_path is required", ErrInvalidShare)
	}
	if sh.Username == "" || len(sh.Username) > maxShareUsernameLen || strings.ContainsRune(sh.Username, ':') ||
		strings.IndexFunc(sh.Username, unicode.IsControl) >= 0 {
		return fmt.Errorf("%w: username must be 1-%d printable characters without ':'", ErrInvalidShare, maxShareUsernameLen)
	}
	return nil
}

// validateRow is ValidateShare plus the password hash a stored row needs.
func validateRow(sh Share) error {
	if err := ValidateShare(sh); err != nil {
		return err
	}
	if sh.PasswordHash == "" {
		return fmt.Errorf("%w: password hash is required", ErrInvalidShare)
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanShare(r rowScanner) (Share, error) {
	var sh Share
	var readOnly, enabled int
	var created int64
	err := r.Scan(&sh.ID, &sh.Name, &sh.AgentID, &sh.RemotePath, &readOnly, &sh.Username,
		&sh.PasswordHash, &enabled, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Share{}, ErrShareNotFound
	}
	if err != nil {
		return Share{}, err
	}
	sh.ReadOnly = readOnly != 0
	sh.Enabled = enabled != 0
	sh.CreatedAt = time.Unix(created, 0).UTC()
	return sh, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
