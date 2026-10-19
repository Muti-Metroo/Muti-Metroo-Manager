package cli

import (
	"bytes"
	"flag"
	"strings"
	"testing"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/config"
)

// TestPrintUsageListsEveryFlag keeps the hand-written help page in step
// with the flags the server actually accepts.
func TestPrintUsageListsEveryFlag(t *testing.T) {
	var buf bytes.Buffer
	printUsage(Build{}, &buf)
	help := buf.String()

	removed := map[string]bool{"downloads-bundle": true, "no-downloads": true}
	config.NewLoadFlags("test", &bytes.Buffer{}).FlagSet().VisitAll(func(f *flag.Flag) {
		if removed[f.Name] {
			return
		}
		if !strings.Contains(help, "-"+f.Name+" ") {
			t.Errorf("help does not list -%s", f.Name)
		}
	})
}
