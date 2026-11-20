package tools

import (
	"context"
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
	// Context bounds the scan. LoadCommandInWindow injects the invocation's
	// context, so a per-file loop can stop when the runner's timeout budget
	// expires instead of finishing the whole tree first; nil means unbounded
	// (a direct LoadX call from a test).
	Context context.Context
	// ReadErrors is where a real read failure is recorded (see readErrorf).
	// It is a pointer because Options travels by value into every adapter: a
	// slice field would be appended to in a copy and the caller would never
	// see the line. nil discards the record (a unit test of one adapter).
	ReadErrors *[]ReadError
}

// ReadError is one recorded read failure. Identity is the full path, used only
// to keep the same file distinct from a different file that shares its base
// name (two `logs.json` under different project roots must both be reported);
// Line is the operator-facing text, which names the base name only. The
// identity is never printed — it exists for the provider's cross-report
// dedupe, not for stderr.
type ReadError struct {
	Identity string
	Line     string
}

// ContextErr reports a cancelled or expired budget. Adapters check it between
// files: the work is one file read at a time, so that is the finest point a
// cancellation can be observed without threading the context through every
// parser. The IO helpers in read.go also consult it while they work, so a
// single large read or database query stops at the deadline too.
func (o Options) ContextErr() error {
	if o.Context == nil {
		return nil
	}
	return o.Context.Err()
}

// contextOrBackground hands the budget to APIs that require a non-nil
// context.Context (database/sql's QueryContext). A nil Context means unbounded,
// which is what a direct adapter call from a test wants.
func (o Options) contextOrBackground() context.Context {
	if o.Context == nil {
		return context.Background()
	}
	return o.Context
}

func (o Options) debugf(line string) {
	if o.Debug != nil {
		o.Debug(line)
	}
}

// readErrorf reports a real read failure so it reaches the operator even when
// Debug is silent.
//
// The adapters keep the ccusage rule for anything that is a parse problem — a
// malformed line or an unrecorded shape is skipped, with the per-file line
// under Debug only (S4 plan: "逐文件解析失败 = 跳过 + 可选 debug 日志"). A file
// that cannot be *read* is different: silently skipping it under-counts the
// user's usage, which AGENTS.md forbids ("真实读取失败必须报错，禁止静默丢数据").
// The caller prints the recorded lines on stderr once the load returns, so the
// row is missing but visible rather than missing and silent.
func (o Options) readErrorf(identity, line string) {
	if o.ReadErrors != nil {
		*o.ReadErrors = append(*o.ReadErrors, ReadError{Identity: identity, Line: line})
	}
}

// Debugf reports a per-file problem that is not a failed read (a vanished file,
// a parse miss), on the same channel and with the same rule as the package's
// own adapters. Exported for the copilot loader, an adapter in its own package.
func (o Options) Debugf(line string) { o.debugf(line) }

// ReadErrorf records a real read failure for the provider to print once the
// load returns, mirroring readErrorf for the copilot loader. identity is the
// full path (for dedupe); line is the base-name-only text that gets printed.
func (o Options) ReadErrorf(identity, line string) { o.readErrorf(identity, line) }

// EnvLookup returns the probe, defaulting to the process environment. It is
// exported for an adapter in its own package (copilot) that reads a tool's
// environment the same way.
func (o Options) EnvLookup() func(string) (string, bool) {
	return o.envLookup()
}

// Home returns the user's home directory through the HomeDir override or
// home_dir, exported alongside EnvLookup.
func (o Options) Home() (string, error) {
	return o.homeDir()
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
