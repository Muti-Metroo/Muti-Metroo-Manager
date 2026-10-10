// Package cli is Muti Metroo Manager's subcommand dispatcher. The actual
// server start-up lives in cmd/manager so the linker-stamped Version
// stays close to the binary.
package cli

import (
	"flag"
	"fmt"
	"io"
	"strings"
)

// RunFunc starts the long-running HTTP server. It is supplied by
// cmd/manager so the package boundary doesn't pull every server
// dependency into `muti-metroo-manager check` or `muti-metroo-manager version`.
type RunFunc func(args []string) int

// Build holds compile-time identifiers stamped in by the linker. main
// passes one of these into Dispatch so every subcommand sees a
// consistent build identity (used by `version` and the startup
// banner).
type Build struct {
	Version string
	Commit  string
	GoVer   string
}

// Dispatch picks a subcommand from os.Args[1:] and returns the
// process exit code. A bare invocation, or one starting with a flag,
// runs the server so the pre-subcommand CLI shape keeps working.
func Dispatch(args []string, build Build, run RunFunc, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return run(nil)
	}

	first := args[0]

	// Legacy and short-form version flags. We match before flag
	// parsing because Go's flag package treats `--version` as a
	// boolean and would error if version were declared as a
	// subcommand-only spelling.
	switch first {
	case "version", "-version", "--version", "-V":
		printVersion(build, stdout)
		return 0
	case "-h", "-help", "--help", "help":
		printUsage(build, stdout)
		return 0
	}

	switch first {
	case "run":
		return run(args[1:])
	case "check":
		return runCheck(args[1:], build, stdout, stderr)
	case "config":
		return runConfig(args[1:], build, stdout, stderr)
	}

	// No subcommand matched — assume legacy `muti-metroo-manager -flag ...`
	// form and pass everything through to run.
	if strings.HasPrefix(first, "-") {
		return run(args)
	}

	fmt.Fprintf(stderr, "muti-metroo-manager: unknown subcommand %q\n", first)
	fmt.Fprintln(stderr, "Run `muti-metroo-manager -h` for usage.")
	return 2
}

// runConfig is the `muti-metroo-manager config <subcommand>` router. Kept here
// (rather than in configshow.go) so it sits next to Dispatch.
func runConfig(args []string, build Build, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "muti-metroo-manager config: missing subcommand (show | init)")
		return 2
	}
	switch args[0] {
	case "show":
		return runConfigShow(args[1:], stdout, stderr)
	case "init":
		return runConfigInit(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "muti-metroo-manager config: unknown subcommand %q (expected show | init)\n", args[0])
		return 2
	}
}

// errorString flattens a flag parse error to text suitable for
// stderr; -h is silenced because flag.Parse already printed usage.
func errorString(err error) string {
	if err == nil || err == flag.ErrHelp {
		return ""
	}
	return err.Error()
}
