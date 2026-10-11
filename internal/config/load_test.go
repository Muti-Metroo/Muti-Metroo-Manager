package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultsApplied(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	d := Defaults()
	if res.Config != d {
		t.Fatalf("expected defaults, got %+v", res.Config)
	}
	for _, k := range Fields() {
		if res.Source[k] != SourceDefault {
			t.Errorf("source[%s] = %q, want default", k, res.Source[k])
		}
	}
}

func TestEnvWinsOverDefault(t *testing.T) {
	t.Setenv(EnvAgentToken, "from-env")
	t.Setenv(EnvAgentTokenLegacy, "")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentToken != "from-env" {
		t.Errorf("AgentToken = %q, want from-env", res.Config.AgentToken)
	}
	if res.Source["agent_token"] != SourceEnv {
		t.Errorf("source[agent_token] = %q, want env", res.Source["agent_token"])
	}
	if len(res.Warnings) != 0 {
		t.Errorf("expected no warnings, got %v", res.Warnings)
	}
}

func TestLegacyEnvWarns(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "legacy-tok")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentToken != "legacy-tok" {
		t.Errorf("AgentToken = %q, want legacy-tok", res.Config.AgentToken)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "MUTI_METROO_TOKEN") {
		t.Errorf("expected deprecation warning for MUTI_METROO_TOKEN, got %v", res.Warnings)
	}
}

func TestNewEnvBeatsLegacy(t *testing.T) {
	t.Setenv(EnvAgentToken, "new")
	t.Setenv(EnvAgentTokenLegacy, "old")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentToken != "new" {
		t.Errorf("AgentToken = %q, want new", res.Config.AgentToken)
	}
	for _, w := range res.Warnings {
		if strings.Contains(w, EnvAgentTokenLegacy) {
			t.Errorf("did not expect legacy warning when new env is set: %v", w)
		}
	}
}

func TestFlagBeatsEnv(t *testing.T) {
	t.Setenv(EnvAgentToken, "env-token")
	t.Setenv(EnvAgentTokenLegacy, "")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-agent-token", "flag-token", "-addr", "127.0.0.1:9999"}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentToken != "flag-token" {
		t.Errorf("AgentToken = %q, want flag-token", res.Config.AgentToken)
	}
	if res.Source["agent_token"] != SourceFlag {
		t.Errorf("source[agent_token] = %q, want flag", res.Source["agent_token"])
	}
	if res.Config.Addr != "127.0.0.1:9999" {
		t.Errorf("Addr = %q, want 127.0.0.1:9999", res.Config.Addr)
	}
	if res.Source["addr"] != SourceFlag {
		t.Errorf("source[addr] = %q, want flag", res.Source["addr"])
	}
}

func TestFileLayer(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	body := `# example
addr = "127.0.0.1:4040"
agent = "https://mesh.example.com"
data_dir = "/var/lib/muti-metroo-manager"
no_downloads = true
`
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-config", cfgPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.Addr != "127.0.0.1:4040" {
		t.Errorf("Addr = %q", res.Config.Addr)
	}
	if res.Config.Agent != "https://mesh.example.com" {
		t.Errorf("Agent = %q", res.Config.Agent)
	}
	if !res.Config.NoDownloads {
		t.Errorf("NoDownloads should be true")
	}
	if res.Source["addr"] != SourceFile {
		t.Errorf("source[addr] = %q, want file", res.Source["addr"])
	}
	if res.Source["downloads_bundle"] != SourceDefault {
		t.Errorf("source[downloads_bundle] = %q, want default", res.Source["downloads_bundle"])
	}
}

func TestFileRejectsUnknownKey(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(cfgPath, []byte(`unknown_field = "x"`), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-config", cfgPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if _, err := lf.Resolve(); err == nil {
		t.Fatal("expected error for unknown key")
	}
}

func TestFileRejectsAgentTokenInline(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(cfgPath, []byte(`agent_token = "no"`), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-config", cfgPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err := lf.Resolve()
	if err == nil {
		t.Fatal("expected error for inline agent_token")
	}
	if !strings.Contains(err.Error(), "agent_token_file") {
		t.Errorf("error %q should hint at agent_token_file", err.Error())
	}
}

func TestTokenFile(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	dir := t.TempDir()
	tokPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokPath, []byte("file-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-agent-token-file", tokPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentToken != "file-token" {
		t.Errorf("AgentToken = %q, want file-token", res.Config.AgentToken)
	}
	if res.Source["agent_token"] != SourceTokenFile {
		t.Errorf("source[agent_token] = %q, want token-file", res.Source["agent_token"])
	}
}

func TestTokenFileLosesToFlag(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	dir := t.TempDir()
	tokPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokPath, []byte("from-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-agent-token-file", tokPath, "-agent-token", "from-flag"}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentToken != "from-flag" {
		t.Errorf("AgentToken = %q, want from-flag", res.Config.AgentToken)
	}
	if res.Source["agent_token"] != SourceFlag {
		t.Errorf("source[agent_token] = %q, want flag", res.Source["agent_token"])
	}
}

func TestEmptyTokenFile(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	dir := t.TempDir()
	tokPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokPath, []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-agent-token-file", tokPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if _, err := lf.Resolve(); err == nil {
		t.Fatal("expected error for empty token file")
	}
}

func TestParseFlatHandlesCommentsAndQuotes(t *testing.T) {
	in := `
# leading comment
key1 = "hello world"          # inline comment
key2 = true
key3 = false # off
key4 = "with \"quotes\" inside"
key5 = "tab\there"
`
	got, err := parseFlat(strings.NewReader(in))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := map[string]any{
		"key1": "hello world",
		"key2": true,
		"key3": false,
		"key4": `with "quotes" inside`,
		"key5": "tab\there",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

func TestParseFlatRejectsTables(t *testing.T) {
	if _, err := parseFlat(strings.NewReader("[section]\nkey = 1\n")); err == nil {
		t.Fatal("expected error for [section]")
	}
}

func TestRoundTripInitTemplateIsPlaceholder(t *testing.T) {
	// We can't import internal/cli from internal/config (would cycle),
	// but we can at least confirm parseFlat accepts a render of the
	// defaults wrapped in a TOML body. This guards against the parser
	// regressing to the point where its own emitted output won't load.
	body := `# header
addr = ":3000"
agent = "http://127.0.0.1:8080"
agent_token_file = ""
data_dir = "."
downloads_bundle = ""
no_downloads = false
`
	got, err := parseFlat(strings.NewReader(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got["addr"] != ":3000" || got["agent"] != "http://127.0.0.1:8080" || got["no_downloads"] != false {
		t.Errorf("round-trip parse missing fields: %+v", got)
	}
}

func TestAuthTokenEnv(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	t.Setenv(EnvAuthToken, "manager-env-token")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AuthToken != "manager-env-token" {
		t.Errorf("AuthToken = %q, want manager-env-token", res.Config.AuthToken)
	}
	if res.Source["auth_token"] != SourceEnv {
		t.Errorf("source[auth_token] = %q, want env", res.Source["auth_token"])
	}
	if len(res.Warnings) != 0 {
		t.Errorf("expected no warnings, got %v", res.Warnings)
	}
}

func TestAuthTokenFlagWarnsAboutProc(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	t.Setenv(EnvAuthToken, "")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-auth-token", "inline-token"}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AuthToken != "inline-token" {
		t.Errorf("AuthToken = %q, want inline-token", res.Config.AuthToken)
	}
	if res.Source["auth_token"] != SourceFlag {
		t.Errorf("source[auth_token] = %q, want flag", res.Source["auth_token"])
	}
	found := false
	for _, w := range res.Warnings {
		if strings.Contains(w, "/proc") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a /proc exposure warning, got %v", res.Warnings)
	}
}

func TestAuthTokenFile(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	t.Setenv(EnvAuthToken, "")
	dir := t.TempDir()
	tokPath := filepath.Join(dir, "auth-token")
	if err := os.WriteFile(tokPath, []byte("file-auth-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-auth-token-file", tokPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AuthToken != "file-auth-token" {
		t.Errorf("AuthToken = %q, want file-auth-token", res.Config.AuthToken)
	}
	if res.Source["auth_token"] != SourceTokenFile {
		t.Errorf("source[auth_token] = %q, want token-file", res.Source["auth_token"])
	}
}

func TestFileLayerAuthKeys(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	t.Setenv(EnvAuthToken, "")
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	body := "auth_token_file = \"/etc/mmm/auth-token\"\ninsecure_no_auth = true\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-config", cfgPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	// The referenced token file doesn't exist, so resolution fails at
	// the token-file step — proving the file-layer keys were applied.
	if _, err := lf.Resolve(); err == nil ||
		!strings.Contains(err.Error(), "auth_token_file") {
		t.Fatalf("expected auth_token_file read error, got %v", err)
	}
}

func TestFileRejectsAuthTokenInline(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(cfgPath, []byte("auth_token = \"abc\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-config", cfgPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if _, err := lf.Resolve(); err == nil ||
		!strings.Contains(err.Error(), "auth_token") {
		t.Fatalf("expected auth_token-in-file rejection, got %v", err)
	}
}

func TestAgentTLSFlags(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	t.Setenv(EnvAuthToken, "")
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-agent-ca-bundle", "/etc/mmm/ca.pem", "-insecure-skip-verify"}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentCABundle != "/etc/mmm/ca.pem" {
		t.Errorf("AgentCABundle = %q", res.Config.AgentCABundle)
	}
	if !res.Config.InsecureSkipVerify {
		t.Error("InsecureSkipVerify = false, want true")
	}
	if res.Source["agent_ca_bundle"] != SourceFlag || res.Source["insecure_skip_verify"] != SourceFlag {
		t.Errorf("sources = %q/%q, want flag/flag",
			res.Source["agent_ca_bundle"], res.Source["insecure_skip_verify"])
	}
}

func TestFileLayerAgentTLSKeys(t *testing.T) {
	t.Setenv(EnvAgentToken, "")
	t.Setenv(EnvAgentTokenLegacy, "")
	t.Setenv(EnvAuthToken, "")
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	body := "agent_ca_bundle = \"/etc/mmm/ca.pem\"\ninsecure_skip_verify = true\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	lf := NewLoadFlags("test", &bytes.Buffer{})
	if err := lf.Parse([]string{"-config", cfgPath}); err != nil {
		t.Fatalf("parse: %v", err)
	}
	res, err := lf.Resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Config.AgentCABundle != "/etc/mmm/ca.pem" || !res.Config.InsecureSkipVerify {
		t.Errorf("got %+v", res.Config)
	}
	if res.Source["agent_ca_bundle"] != SourceFile || res.Source["insecure_skip_verify"] != SourceFile {
		t.Errorf("sources = %q/%q, want file/file",
			res.Source["agent_ca_bundle"], res.Source["insecure_skip_verify"])
	}
}
