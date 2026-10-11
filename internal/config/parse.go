package config

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// parseFlat reads a flat TOML-subset config: one `key = value` pair
// per line, optional `# comment` after the value, and bare `# comment`
// lines are ignored. Values may be quoted strings, booleans, or
// integers. Tables (`[section]`), arrays, and multi-line strings are
// rejected so a syntactically odd file fails loud rather than silently
// dropping fields.
//
// Returning a map keyed on the literal toml key keeps this layer
// schema-agnostic; the caller (loadFile) maps it to Config fields and
// rejects unknown keys.
func parseFlat(r io.Reader) (map[string]any, error) {
	out := make(map[string]any)
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			return nil, fmt.Errorf("line %d: TOML tables are not supported in this config", lineNo)
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			return nil, fmt.Errorf("line %d: expected key = value, got %q", lineNo, line)
		}
		key := strings.TrimSpace(line[:eq])
		rest := strings.TrimSpace(line[eq+1:])
		val, err := parseValue(rest)
		if err != nil {
			return nil, fmt.Errorf("line %d (%s): %w", lineNo, key, err)
		}
		if !isValidKey(key) {
			return nil, fmt.Errorf("line %d: invalid key %q", lineNo, key)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate key %q", lineNo, key)
		}
		out[key] = val
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// parseValue handles a single right-hand-side: a quoted string, an
// unquoted bool, an integer, or any of those followed by a `# trailing
// comment`. Anything else is a parse error.
func parseValue(s string) (any, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("missing value")
	}
	if s[0] == '"' {
		return parseQuotedString(s)
	}
	// Strip trailing comment for bool/int.
	if hash := strings.IndexByte(s, '#'); hash >= 0 {
		s = strings.TrimSpace(s[:hash])
	}
	switch s {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, nil
	}
	return nil, fmt.Errorf("unrecognised value %q (expected quoted string, bool, or integer)", s)
}

// parseQuotedString consumes a "..." string with the small set of
// escapes Muti Metroo Manager's config actually uses. Anything richer (multiline
// strings, raw strings) is intentionally rejected so a typo doesn't
// silently change semantics.
func parseQuotedString(s string) (string, error) {
	if len(s) < 2 || s[0] != '"' {
		return "", fmt.Errorf("expected quoted string")
	}
	var b strings.Builder
	i := 1
	for i < len(s) {
		c := s[i]
		if c == '"' {
			rest := strings.TrimSpace(s[i+1:])
			if rest != "" && !strings.HasPrefix(rest, "#") {
				return "", fmt.Errorf("unexpected text after closing quote: %q", rest)
			}
			return b.String(), nil
		}
		if c == '\\' {
			if i+1 >= len(s) {
				return "", fmt.Errorf("trailing backslash in string")
			}
			switch s[i+1] {
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			default:
				return "", fmt.Errorf("unsupported escape \\%c", s[i+1])
			}
			i += 2
			continue
		}
		b.WriteByte(c)
		i++
	}
	return "", fmt.Errorf("unterminated string")
}

func isValidKey(k string) bool {
	if k == "" {
		return false
	}
	for i := 0; i < len(k); i++ {
		c := k[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}
