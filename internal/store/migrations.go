package store

import (
	"database/sql"
	"fmt"
)

// Each migration runs inside a transaction; user_version bumps on
// success. Add a new migration by appending to this slice — index+1 is
// the target user_version.
var migrations = []func(*sql.Tx) error{
	migrate1CreateSettings,
	migrate2CreateAgentNotes,
	migrate3AddAgentIcon,
	migrate4AddAgentNetworks,
	migrate5CreateNetworks,
	migrate6CreatePositions,
}

func (s *Store) migrate() error {
	var current int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&current); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	if current == 0 {
		s.firstRun = true
	}
	for i := current; i < len(migrations); i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if err := migrations[i](tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		// PRAGMA user_version doesn't accept parameters, so format it in.
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return fmt.Errorf("bump user_version to %d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func migrate1CreateSettings(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE settings (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`)
	return err
}

func migrate2CreateAgentNotes(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE agent_notes (
			agent_id   TEXT PRIMARY KEY,
			note       TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`)
	return err
}

func migrate3AddAgentIcon(tx *sql.Tx) error {
	_, err := tx.Exec(`ALTER TABLE agent_notes ADD COLUMN icon TEXT NOT NULL DEFAULT ''`)
	return err
}

// migrate4AddAgentNetworks stores each agent's network memberships as a
// comma-separated list of identifiers on the existing agent_notes row.
func migrate4AddAgentNetworks(tx *sql.Tx) error {
	_, err := tx.Exec(`ALTER TABLE agent_notes ADD COLUMN networks TEXT NOT NULL DEFAULT ''`)
	return err
}

// migrate5CreateNetworks holds the operator-editable display name for a
// network. Membership lives on agent_notes.networks (keyed by the stable
// identifier); this table only carries a name override, so a network with
// no custom name (name == id) is simply absent.
func migrate5CreateNetworks(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE networks (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`)
	return err
}

// migrate6CreatePositions persists operator-placed map positions so a
// dragged layout is shared across browsers and recovers on reconnect.
// Keyed by the agent short_id the topology map uses for geometry.
func migrate6CreatePositions(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE agent_positions (
			short_id   TEXT PRIMARY KEY,
			x          REAL NOT NULL,
			y          REAL NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`)
	return err
}
