package store

import (
	"errors"
	"math"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestMigrationsReachLatestVersion(t *testing.T) {
	s := openTestStore(t)
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	if v != len(migrations) {
		t.Errorf("user_version = %d, want %d", v, len(migrations))
	}
}

func TestAgentNetworksRoundTrip(t *testing.T) {
	s := openTestStore(t)
	const id = "0123456789abcdef0123456789abcdef"

	if err := s.UpdateAgentMetadata(id, AgentMeta{Networks: "prod,edge-1"}); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := s.GetAgentMetadata()
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got[id].Networks != "prod,edge-1" {
		t.Errorf("networks = %q, want %q", got[id].Networks, "prod,edge-1")
	}

	// Clearing every field deletes the row.
	if err := s.UpdateAgentMetadata(id, AgentMeta{}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _ = s.GetAgentMetadata()
	if _, ok := got[id]; ok {
		t.Error("row should be deleted when all fields empty")
	}
}

func TestAgentNetworksValidation(t *testing.T) {
	s := openTestStore(t)
	const id = "0123456789abcdef0123456789abcdef"
	for _, bad := range []string{"has space", "trailing,", "a,,b", "comma,ok,in valid"} {
		if err := s.UpdateAgentMetadata(id, AgentMeta{Networks: bad}); !errors.Is(err, ErrInvalidNetworks) {
			t.Errorf("networks %q: err = %v, want ErrInvalidNetworks", bad, err)
		}
	}
}

func TestNetworkNameUpsertAndClear(t *testing.T) {
	s := openTestStore(t)

	name, err := s.UpsertNetwork("prod", "Production")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if name != "Production" {
		t.Errorf("effective name = %q, want Production", name)
	}
	names, _ := s.GetNetworks()
	if names["prod"] != "Production" {
		t.Errorf("stored name = %q", names["prod"])
	}

	// A name equal to the id stores no override (row deleted).
	if name, _ = s.UpsertNetwork("prod", "prod"); name != "prod" {
		t.Errorf("effective name = %q, want prod", name)
	}
	names, _ = s.GetNetworks()
	if _, ok := names["prod"]; ok {
		t.Error("override should be cleared when name == id")
	}

	if _, err := s.UpsertNetwork("bad id", "x"); !errors.Is(err, ErrInvalidNetworkID) {
		t.Errorf("bad id: err = %v, want ErrInvalidNetworkID", err)
	}
}

func TestPositionsReplaceAll(t *testing.T) {
	s := openTestStore(t)

	if err := s.ReplacePositions(map[string]Position{"aaaa": {X: 1, Y: 2}, "bbbb": {X: -3, Y: 4}}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, _ := s.GetPositions()
	if len(got) != 2 || got["aaaa"] != (Position{X: 1, Y: 2}) {
		t.Errorf("positions = %+v", got)
	}

	// Replace-all: keys absent from the new map are removed.
	if err := s.ReplacePositions(map[string]Position{"aaaa": {X: 9, Y: 9}}); err != nil {
		t.Fatalf("replace 2: %v", err)
	}
	got, _ = s.GetPositions()
	if len(got) != 1 || got["aaaa"] != (Position{X: 9, Y: 9}) {
		t.Errorf("after replace = %+v", got)
	}

	// Empty map clears the table (reset view).
	if err := s.ReplacePositions(map[string]Position{}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got, _ = s.GetPositions(); len(got) != 0 {
		t.Errorf("expected empty, got %+v", got)
	}
}

func TestPositionsValidation(t *testing.T) {
	s := openTestStore(t)
	// A bad key must abort the whole write (no partial application).
	err := s.ReplacePositions(map[string]Position{"ok": {X: 1, Y: 1}, "bad key": {X: 0, Y: 0}})
	if !errors.Is(err, ErrInvalidPosition) {
		t.Errorf("bad key: err = %v, want ErrInvalidPosition", err)
	}
	if got, _ := s.GetPositions(); len(got) != 0 {
		t.Errorf("nothing should be written on validation failure, got %+v", got)
	}
	if err := s.ReplacePositions(map[string]Position{"ok": {X: math.Inf(1), Y: 0}}); !errors.Is(err, ErrInvalidPosition) {
		t.Errorf("non-finite: err = %v, want ErrInvalidPosition", err)
	}
}
