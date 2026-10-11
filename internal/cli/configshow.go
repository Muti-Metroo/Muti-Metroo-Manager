package cli

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/postalsys/muti-metroo-manager/internal/config"
)

// runConfigShow implements `muti-metroo-manager config show`. It prints the
// resolved Config in TOML form, with each line annotated by the
// source layer that produced its value (`# default | file | env |
// flag`). The intent is the auditor question: "show me what this
// process actually used."
//
// The bearer token, if set, is replaced with `"<redacted>"` so this
// command stays safe to paste into a ticket. Everything else is the
// literal value the running server would see.
func runConfigShow(args []string, stdout, stderr io.Writer) int {
	lf := config.NewLoadFlags("muti-metroo-manager config show", stderr)
	lf.FlagSet().Usage = func() {
		fmt.Fprintln(stderr, "usage: muti-metroo-manager config show [flags]")
		fmt.Fprintln(stderr, "Prints the effective configuration with provenance per field.")
		fmt.Fprintln(stderr)
		lf.FlagSet().PrintDefaults()
	}
	if err := lf.Parse(args); err != nil {
		if msg := errorString(err); msg != "" {
			fmt.Fprintln(stderr, msg)
		}
		return 2
	}
	res, err := lf.Resolve()
	if err != nil {
		fmt.Fprintf(stderr, "config: %v\n", err)
		return 2
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(stderr, "warn: %s\n", w)
	}
	renderShow(res, stdout)
	return 0
}

func renderShow(res config.LoadResult, w io.Writer) {
	fmt.Fprintln(w, "# muti-metroo-manager config show — effective configuration")
	if res.ConfigPath != "" {
		fmt.Fprintf(w, "# config file: %s\n", res.ConfigPath)
	} else {
		fmt.Fprintln(w, "# config file: (none)")
	}
	fmt.Fprintln(w)

	for _, key := range config.Fields() {
		val := fieldValue(res.Config, key)
		src := res.Source[key]
		comment := "# " + src
		if key == "agent_token" || key == "auth_token" {
			if val != "" {
				val = "<redacted>"
			}
		}
		formatted := formatTOML(val)
		fmt.Fprintf(w, "%-20s = %-30s %s\n", key, formatted, comment)
	}
}

// fieldValue projects Config into a string keyed by the canonical
// TOML name. Bool fields are returned as their TOML literal so the
// formatter can decide whether to quote.
func fieldValue(cfg config.Config, key string) any {
	switch key {
	case "addr":
		return cfg.Addr
	case "agent":
		return cfg.Agent
	case "agent_token":
		return cfg.AgentToken
	case "agent_token_file":
		return cfg.AgentTokenFile
	case "auth_token":
		return cfg.AuthToken
	case "auth_token_file":
		return cfg.AuthTokenFile
	case "insecure_no_auth":
		return cfg.InsecureNoAuth
	case "data_dir":
		return cfg.DataDir
	case "downloads_bundle":
		return cfg.DownloadsBundle
	case "no_downloads":
		return cfg.NoDownloads
	case "log_level":
		return cfg.LogLevel
	case "log_format":
		return cfg.LogFormat
	case "metrics_addr":
		return cfg.MetricsAddr
	}
	return ""
}

// formatTOML renders a value so the output round-trips through
// parseFlat: strings get quoted with the same minimal escapes the
// parser understands, bools get their literal form.
func formatTOML(v any) string {
	switch x := v.(type) {
	case bool:
		return strconv.FormatBool(x)
	case string:
		return strconv.Quote(replaceUnsupported(x))
	}
	return fmt.Sprintf("%v", v)
}

// replaceUnsupported strips control characters our minimal parser
// doesn't accept. In practice muti-metroo-manager config values are URLs and
// paths, so this is a defence-in-depth check rather than a hot path.
func replaceUnsupported(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' {
			return -1
		}
		return r
	}, s)
}
