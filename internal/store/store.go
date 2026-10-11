// Package store owns Muti Metroo Manager's SQLite-backed persistent state. Today
// it holds a key/value settings table and per-agent operator metadata
// (notes + icon); future domains (saved searches, etc.) drop in as new
// tables behind their own typed methods — the generic key/value table
// is not the extension point, new tables are.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Store is the process-wide handle to Muti Metroo Manager's SQLite database.
// Safe for concurrent use by HTTP handlers — database/sql serialises
// writes internally and WAL mode allows concurrent readers.
type Store struct {
	db         *sql.DB
	firstRun   bool // true when migrate() ran starting at user_version 0
	pathOnDisk string
}

// Settings values that travel over the /api/settings wire. JSON field
// names are the storage keys; an empty string means "no override, fall
// back to the frontend default".
type Settings struct {
	APIAddress    string `json:"api_address"`
	SocksAddress  string `json:"socks_address"`
	SoundsEnabled bool   `json:"sounds_enabled"`
	// SoundsLocked is server-only; set on the GET response when the
	// operator has disabled sounds via CLI/config so the UI can grey
	// the toggle. Never persisted; ignored on PUT.
	SoundsLocked bool `json:"sounds_locked,omitempty"`
}

// Open initialises the SQLite database at <dataDir>/muti-metroo-manager.db,
// creating the directory if it doesn't exist, and applies any pending
// schema migrations.
func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, "muti-metroo-manager.db")
	dsn := "file:" + dbPath + sqlitePragmaQuery
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	s := &Store{db: db, pathOnDisk: dbPath}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// FirstRun reports whether this Open created the schema from scratch
// (user_version was 0 before migrations ran). The startup banner
// uses this to nudge operators into backing up the new DB file.
func (s *Store) FirstRun() bool {
	if s == nil {
		return false
	}
	return s.firstRun
}

// Path returns the on-disk SQLite file path. Used for log/banner
// output ("data-dir: <path>").
func (s *Store) Path() string {
	if s == nil {
		return ""
	}
	return s.pathOnDisk
}

// Close releases the underlying database handle.
func (s *Store) Close() error {
	return s.db.Close()
}

// GetSettings returns the persisted settings. Missing keys resolve to
// empty strings — the caller treats those as "no override". Sounds
// default to enabled when the row is absent.
func (s *Store) GetSettings() (Settings, error) {
	out := Settings{SoundsEnabled: true}
	rows, err := s.db.Query(`SELECT key, value FROM settings WHERE key IN (?, ?, ?)`,
		keyAPIAddress, keySocksAddress, keySounds)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return out, err
		}
		switch k {
		case keyAPIAddress:
			out.APIAddress = v
		case keySocksAddress:
			out.SocksAddress = v
		case keySounds:
			out.SoundsEnabled = v == "1"
		}
	}
	return out, rows.Err()
}

// UpdateSettings replaces the persisted settings atomically. The api
// address accepts host:port or http(s)://host[:port][/prefix] (matching
// what `muti-metroo shell -a` accepts upstream — see
// ../Muti-Metroo/internal/apiclient/endpoint.go:Parse). The socks address is
// host:port only. An empty string clears the override so the frontend
// falls back to its default.
func (s *Store) UpdateSettings(ss Settings) (Settings, error) {
	apiAddr, err := normalizeAgentEndpoint(ss.APIAddress)
	if err != nil {
		return Settings{}, fmt.Errorf("api_address: %w", err)
	}
	socksAddr, err := normalizeHostPort(ss.SocksAddress)
	if err != nil {
		return Settings{}, fmt.Errorf("socks_address: %w", err)
	}
	ss = Settings{APIAddress: apiAddr, SocksAddress: socksAddr, SoundsEnabled: ss.SoundsEnabled}
	tx, err := s.db.Begin()
	if err != nil {
		return Settings{}, err
	}
	defer tx.Rollback()
	if err := upsert(tx, keyAPIAddress, ss.APIAddress); err != nil {
		return Settings{}, err
	}
	if err := upsert(tx, keySocksAddress, ss.SocksAddress); err != nil {
		return Settings{}, err
	}
	soundsVal := "0"
	if ss.SoundsEnabled {
		soundsVal = "1"
	}
	if err := upsert(tx, keySounds, soundsVal); err != nil {
		return Settings{}, err
	}
	if err := tx.Commit(); err != nil {
		return Settings{}, err
	}
	return ss, nil
}

// ErrInvalidAddress is returned when a settings value fails validation.
// Handlers map this to 400 Bad Request.
var ErrInvalidAddress = errors.New("invalid address")

// ErrInvalidAgentID is returned when an agent ID argument is not the
// expected 32-character hex form. Handlers map this to 400.
var ErrInvalidAgentID = errors.New("invalid agent id")

// AgentMeta is the operator-set, per-agent metadata persisted in
// muti-metroo-manager.db. Today: a free-form note, an icon key (the icon catalog
// itself lives in the frontend; the backend just stores the chosen key),
// and a comma-separated list of network membership identifiers.
type AgentMeta struct {
	Note     string `json:"note"`
	Icon     string `json:"icon"`
	Networks string `json:"networks"`
}

// ErrInvalidIcon is returned when an icon key fails the character-set /
// length check. Handlers map this to 400.
var ErrInvalidIcon = errors.New("invalid icon")

// ErrInvalidNetworks is returned when the networks membership string is
// not a comma-separated list of valid identifiers. Handlers map this to 400.
var ErrInvalidNetworks = errors.New("invalid networks")

// GetAgentMetadata returns every stored agent's operator metadata as a
// {agentID: AgentMeta} map. Safe to call on every page load — the table
// is small and the query is O(n).
func (s *Store) GetAgentMetadata() (map[string]AgentMeta, error) {
	out := make(map[string]AgentMeta)
	rows, err := s.db.Query(`SELECT agent_id, note, icon, networks FROM agent_notes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var meta AgentMeta
		if err := rows.Scan(&id, &meta.Note, &meta.Icon, &meta.Networks); err != nil {
			return nil, err
		}
		out[id] = meta
	}
	return out, rows.Err()
}

// maxNoteLen bounds an agent note; longer notes are truncated.
const maxNoteLen = 4096

// UpdateAgentMetadata persists meta for agentID. When both note and
// icon are empty the row is deleted so the frontend indicator
// disappears.
func (s *Store) UpdateAgentMetadata(agentID string, meta AgentMeta) error {
	if !isAgentID(agentID) {
		return fmt.Errorf("%w: %q", ErrInvalidAgentID, agentID)
	}
	if !isIconKey(meta.Icon) {
		return fmt.Errorf("%w: %q", ErrInvalidIcon, meta.Icon)
	}
	if !isNetworks(meta.Networks) {
		return fmt.Errorf("%w: %q", ErrInvalidNetworks, meta.Networks)
	}
	// Truncate by runes, not bytes, so a multibyte character isn't split.
	if runes := []rune(meta.Note); len(runes) > maxNoteLen {
		meta.Note = string(runes[:maxNoteLen])
	}
	if meta.Note == "" && meta.Icon == "" && meta.Networks == "" {
		_, err := s.db.Exec(`DELETE FROM agent_notes WHERE agent_id = ?`, agentID)
		return err
	}
	_, err := s.db.Exec(`
		INSERT INTO agent_notes(agent_id, note, icon, networks, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET note=excluded.note, icon=excluded.icon, networks=excluded.networks, updated_at=excluded.updated_at
	`, agentID, meta.Note, meta.Icon, meta.Networks, time.Now().Unix())
	return err
}

// ErrInvalidNetworkID is returned when a network identifier fails the
// character-set / length check. Handlers map this to 400.
var ErrInvalidNetworkID = errors.New("invalid network id")

// maxNetworkNameLen bounds a display name; longer names are truncated.
const maxNetworkNameLen = 128

// GetNetworks returns the operator-set display-name overrides as an
// {id: name} map. Networks without an override (name == id) are absent —
// the frontend falls back to the identifier. Safe to call on every load.
func (s *Store) GetNetworks() (map[string]string, error) {
	out := make(map[string]string)
	rows, err := s.db.Query(`SELECT id, name FROM networks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// UpsertNetwork sets the display name for a network identifier and returns
// the effective name. An empty name — or a name equal to the identifier —
// stores no override (the row is deleted) and the identifier is returned,
// so the frontend can drop it from its override map.
func (s *Store) UpsertNetwork(id, name string) (string, error) {
	if !isIdentifier(id, 64) {
		return "", fmt.Errorf("%w: %q", ErrInvalidNetworkID, id)
	}
	name = strings.TrimSpace(name)
	// Truncate by runes, not bytes, so a multibyte character isn't split.
	if runes := []rune(name); len(runes) > maxNetworkNameLen {
		name = string(runes[:maxNetworkNameLen])
	}
	if name == "" || name == id {
		if _, err := s.db.Exec(`DELETE FROM networks WHERE id = ?`, id); err != nil {
			return "", err
		}
		return id, nil
	}
	_, err := s.db.Exec(`
		INSERT INTO networks(id, name, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
	`, id, name, time.Now().Unix())
	return name, err
}

// Position is an operator-placed map position for an agent, keyed by
// short_id (the identifier the topology map uses for geometry).
type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// ErrInvalidPosition is returned when a positions map contains a bad
// short_id key or a non-finite coordinate. Handlers map this to 400.
var ErrInvalidPosition = errors.New("invalid position")

// GetPositions returns every persisted agent position as a {short_id: {x,y}}
// map.
func (s *Store) GetPositions() (map[string]Position, error) {
	out := make(map[string]Position)
	rows, err := s.db.Query(`SELECT short_id, x, y FROM agent_positions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var p Position
		if err := rows.Scan(&id, &p.X, &p.Y); err != nil {
			return nil, err
		}
		out[id] = p
	}
	return out, rows.Err()
}

// ReplacePositions atomically replaces the entire position set with the
// supplied map (replace-all: keys absent from the map are removed). An
// empty map clears the table — the reset-view action. Every key must be a
// valid short_id and every coordinate finite, else nothing is written.
func (s *Store) ReplacePositions(positions map[string]Position) error {
	for id, p := range positions {
		if !isIdentifier(id, 64) {
			return fmt.Errorf("%w: bad short_id %q", ErrInvalidPosition, id)
		}
		if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) {
			return fmt.Errorf("%w: non-finite coordinate for %q", ErrInvalidPosition, id)
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM agent_positions`); err != nil {
		return err
	}
	now := time.Now().Unix()
	for id, p := range positions {
		if _, err := tx.Exec(
			`INSERT INTO agent_positions(short_id, x, y, updated_at) VALUES (?, ?, ?, ?)`,
			id, p.X, p.Y, now,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// isIconKey accepts the empty string (no icon) or [a-z0-9_-]{1,32}.
// The frontend owns the catalog; an unknown key just renders the
// default circle, so the backend only filters out garbage.
func isIconKey(v string) bool {
	if len(v) > 32 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func isAgentID(v string) bool {
	if len(v) != 32 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// isIdentifier accepts [a-zA-Z0-9_-]{1,maxLen} — the shared rule for a
// network identifier and an agent short_id. No spaces or commas, so a
// comma-separated membership list is unambiguous.
func isIdentifier(v string, maxLen int) bool {
	if len(v) == 0 || len(v) > maxLen {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// isNetworks accepts the empty string (no memberships) or a comma-separated
// list of identifiers with no empty entries.
func isNetworks(v string) bool {
	if v == "" {
		return true
	}
	for _, tok := range strings.Split(v, ",") {
		if !isIdentifier(tok, 64) {
			return false
		}
	}
	return true
}

// normalizeAgentEndpoint canonicalises the api_address setting. Accepts
// bare host:port (muti-metroo CLI treats it as http) or http(s)://host[:port][/prefix].
// Rejects credentials, query strings, and fragments — same rules as
// ../Muti-Metroo/internal/apiclient/endpoint.go:Parse.
func normalizeAgentEndpoint(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", nil
	}
	if hasHTTPScheme(v) {
		u, err := url.Parse(v)
		if err != nil || u.Host == "" {
			return "", fmt.Errorf("%w: %q is not a valid URL", ErrInvalidAddress, v)
		}
		if u.User != nil {
			return "", fmt.Errorf("%w: credentials are not allowed", ErrInvalidAddress)
		}
		if u.RawQuery != "" || u.Fragment != "" {
			return "", fmt.Errorf("%w: query or fragment is not allowed", ErrInvalidAddress)
		}
		return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/"), nil
	}
	if strings.Contains(v, "://") {
		return "", fmt.Errorf("%w: only http and https schemes are supported", ErrInvalidAddress)
	}
	if _, _, err := net.SplitHostPort(v); err != nil {
		return "", fmt.Errorf("%w: expected host:port or http(s)://host[:port][/prefix]", ErrInvalidAddress)
	}
	return v, nil
}

// normalizeHostPort validates a bare host:port. SOCKS5 addresses use
// this form; no scheme or path is meaningful.
func normalizeHostPort(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", nil
	}
	if _, _, err := net.SplitHostPort(v); err != nil {
		return "", fmt.Errorf("%w: expected host:port", ErrInvalidAddress)
	}
	return v, nil
}

func hasHTTPScheme(v string) bool {
	lower := strings.ToLower(v)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

func upsert(tx *sql.Tx, key, value string) error {
	if value == "" {
		_, err := tx.Exec(`DELETE FROM settings WHERE key = ?`, key)
		return err
	}
	_, err := tx.Exec(`
		INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
	`, key, value, time.Now().Unix())
	return err
}

const (
	keyAPIAddress   = "api_address"
	keySocksAddress = "socks_address"
	keySounds       = "sounds_enabled"
)

// WAL keeps reads non-blocking during operator updates; foreign_keys
// is on for future schemas; busy_timeout rides out the brief window
// where a writer is upgrading a transaction.
const sqlitePragmaQuery = "?_pragma=journal_mode(WAL)" +
	"&_pragma=foreign_keys(1)" +
	"&_pragma=busy_timeout(5000)"
