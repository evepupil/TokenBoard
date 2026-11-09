package tools

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// Options is what every tool adapter needs from its caller: the child
// environment ccusage would have seen, the report timezone, the pricing corpus
// and the cost mode.
type Options struct {
	// Env is a Lookup-style probe (a set-but-empty variable must read as set).
	Env func(key string) (string, bool)
	// HomeDir resolves the user's home when a tool needs its default data
	// directory. nil means the process environment.
	HomeDir func() (string, error)
	// Timezone is the report timezone ("UTC", an IANA name, "" or "local").
	Timezone string
	// Mode is the cost mode ccusage resolved from the config.
	Mode nativepricing.CostMode
	// Corpus is the frozen pricing table.
	Corpus nativepricing.Corpus
	// Debug receives per-file failure lines the Rust adapters only print under
	// --debug. nil discards them.
	Debug func(line string)
}

func (o Options) debugf(line string) {
	if o.Debug != nil {
		o.Debug(line)
	}
}

// envLookup returns the probe, defaulting to the process environment.
func (o Options) envLookup() func(string) (string, bool) {
	if o.Env != nil {
		return o.Env
	}
	return os.LookupEnv
}

// resolveRoots implements the comma-list root resolution every tool's paths.rs
// shares: when the variable is set, its parts are the only candidates (a set
// but empty value means zero roots, never a fallback); otherwise the tool's
// defaults apply. keep filters each candidate (the Rust adapters differ: most
// require a directory, zcode defers to the database path).
func resolveRoots(o Options, key string, defaults []string, keep func(string) bool) ([]string, error) {
	if raw, ok := o.envLookup()(key); ok {
		roots := SplitEnvList(raw)
		out := roots[:0]
		for _, root := range roots {
			if keep(root) {
				out = append(out, root)
			}
		}
		return DedupePaths(out), nil
	}
	home, err := o.homeDir()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(defaults))
	for _, candidate := range defaults {
		expanded := expandHome(candidate, home)
		if keep(expanded) {
			out = append(out, expanded)
		}
	}
	return DedupePaths(out), nil
}

// homeDir is home_dir (core/src/home.rs:3-31): HOME, then USERPROFILE, then
// HOMEDRIVE+HOMEPATH, and a hard error when none is set.
func (o Options) homeDir() (string, error) {
	if o.HomeDir != nil {
		return o.HomeDir()
	}
	env := o.envLookup()
	if home, ok := env("HOME"); ok && home != "" {
		return home, nil
	}
	if profile, ok := env("USERPROFILE"); ok && profile != "" {
		return profile, nil
	}
	drive, driveOK := env("HOMEDRIVE")
	path, pathOK := env("HOMEPATH")
	if driveOK && pathOK && drive+path != "" {
		return drive + path, nil
	}
	return "", errors.New("home directory is not set")
}

func expandHome(path, home string) string {
	if path == "~" {
		return home
	}
	if len(path) > 1 && path[0] == '~' && path[1] == '/' {
		return filepath.Join(home, path[2:])
	}
	return path
}
