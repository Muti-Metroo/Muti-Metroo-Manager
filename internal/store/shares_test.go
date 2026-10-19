package store

import (
	"errors"
	"testing"
)

const testAgentID = "0123456789abcdef0123456789abcdef"

func testShare(name string) Share {
	return Share{
		Name:         name,
		AgentID:      testAgentID,
		RemotePath:   "/srv/files",
		ReadOnly:     true,
		Username:     "alice",
		PasswordHash: "$2a$10$hash",
		Enabled:      true,
	}
}

func TestShareCreateGetList(t *testing.T) {
	s := openTestStore(t)

	created, err := s.CreateShare(testShare("docs"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == 0 || created.CreatedAt.IsZero() {
		t.Errorf("id/created_at not assigned: %+v", created)
	}
	if !created.ReadOnly || !created.Enabled || created.PasswordHash != "$2a$10$hash" {
		t.Errorf("fields not persisted: %+v", created)
	}

	byName, err := s.GetShareByName("docs")
	if err != nil || byName.ID != created.ID {
		t.Fatalf("get by name = %+v, %v", byName, err)
	}
	if _, err := s.GetShareByName("nope"); !errors.Is(err, ErrShareNotFound) {
		t.Errorf("unknown name: err = %v, want ErrShareNotFound", err)
	}
	if _, err := s.GetShare(9999); !errors.Is(err, ErrShareNotFound) {
		t.Errorf("unknown id: err = %v, want ErrShareNotFound", err)
	}

	if _, err := s.CreateShare(testShare("alpha")); err != nil {
		t.Fatalf("create 2: %v", err)
	}
	list, err := s.ListShares()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 || list[0].Name != "alpha" || list[1].Name != "docs" {
		t.Errorf("list order = %+v", list)
	}
}

func TestShareNameUnique(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.CreateShare(testShare("docs")); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := s.CreateShare(testShare("docs")); !errors.Is(err, ErrShareExists) {
		t.Errorf("duplicate: err = %v, want ErrShareExists", err)
	}
}

func TestShareValidation(t *testing.T) {
	s := openTestStore(t)
	cases := map[string]func(*Share){
		"upper-case name":   func(sh *Share) { sh.Name = "Docs" },
		"slash in name":     func(sh *Share) { sh.Name = "a/b" },
		"leading dash":      func(sh *Share) { sh.Name = "-docs" },
		"empty name":        func(sh *Share) { sh.Name = "" },
		"dot name":          func(sh *Share) { sh.Name = ".." },
		"short agent id":    func(sh *Share) { sh.AgentID = "abc" },
		"empty path":        func(sh *Share) { sh.RemotePath = "" },
		"colon in username": func(sh *Share) { sh.Username = "a:b" },
		"empty username":    func(sh *Share) { sh.Username = "" },
		"no password hash":  func(sh *Share) { sh.PasswordHash = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			sh := testShare("docs")
			mutate(&sh)
			if _, err := s.CreateShare(sh); !errors.Is(err, ErrInvalidShare) {
				t.Errorf("err = %v, want ErrInvalidShare", err)
			}
		})
	}
}

func TestShareUpdateAndDelete(t *testing.T) {
	s := openTestStore(t)
	sh, err := s.CreateShare(testShare("docs"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	no, yes, hash := false, false, "$2a$10$other"
	updated, err := s.UpdateShare(sh.ID, ShareUpdate{Enabled: &no, ReadOnly: &yes, PasswordHash: &hash})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Enabled || updated.ReadOnly || updated.PasswordHash != hash {
		t.Errorf("update not applied: %+v", updated)
	}
	got, _ := s.GetShare(sh.ID)
	if got.Enabled || got.ReadOnly || got.PasswordHash != hash || got.Name != "docs" {
		t.Errorf("update not persisted: %+v", got)
	}

	// A nil field leaves the value alone.
	if got, _ = s.UpdateShare(sh.ID, ShareUpdate{}); got.PasswordHash != hash {
		t.Errorf("empty update changed hash: %+v", got)
	}

	if _, err := s.UpdateShare(9999, ShareUpdate{Enabled: &no}); !errors.Is(err, ErrShareNotFound) {
		t.Errorf("update unknown: err = %v", err)
	}
	if err := s.DeleteShare(sh.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := s.DeleteShare(sh.ID); !errors.Is(err, ErrShareNotFound) {
		t.Errorf("second delete: err = %v, want ErrShareNotFound", err)
	}
	if _, err := s.GetShareByName("docs"); !errors.Is(err, ErrShareNotFound) {
		t.Errorf("share still present after delete: %v", err)
	}
}

// Shares survive a close + reopen of the same data dir.
func TestSharePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := s.CreateShare(testShare("docs")); err != nil {
		t.Fatalf("create: %v", err)
	}
	s.Close()

	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if _, err := s2.GetShareByName("docs"); err != nil {
		t.Errorf("share lost across reopen: %v", err)
	}
}

func TestNormalizeShare(t *testing.T) {
	sh := NormalizeShare(Share{Name: " docs ", AgentID: " ABCDEF ", RemotePath: " /srv/x ", Username: " bob "})
	if sh.Name != "docs" || sh.AgentID != "abcdef" || sh.RemotePath != "/srv/x" || sh.Username != "bob" {
		t.Errorf("normalized = %+v", sh)
	}
	if err := ValidateShare(testShare("docs")); err != nil {
		t.Errorf("valid share rejected: %v", err)
	}
	noHash := testShare("docs")
	noHash.PasswordHash = ""
	if err := ValidateShare(noHash); err != nil {
		t.Errorf("ValidateShare requires the hash: %v", err)
	}
}
