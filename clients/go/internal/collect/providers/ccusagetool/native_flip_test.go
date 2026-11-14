package ccusagetool

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// TestNativeToolsAreTheDefaultPath is the S5 gate: every tool source has a
// native adapter behind the registry, and a default Collect over a home with
// no tool install never reaches the caller's report runner.
func TestNativeToolsAreTheDefaultPath(t *testing.T) {
	for _, source := range contract.CcusageToolSources() {
		if _, ok := collect.LookupNative(source); !ok {
			t.Fatalf("no native provider registered for %s", source)
		}
	}
	// A scratch home: the tester's own amp history must not leak in.
	home := t.TempDir()
	for _, dir := range []string{"threads"} {
		if err := os.MkdirAll(filepath.Join(home, "amp", dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// No Runner is injected: the default path builds its own in-process
	// runner, and a regression that wanted a report would have to fail here
	// rather than answer from a stub.
	snapshots, err := Collect(context.Background(), contract.Source("amp"), Options{
		Env: func(key string) string {
			if key == "AMP_DATA_DIR" {
				return filepath.Join(home, "amp")
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none for a tool-less home", snapshots)
	}
}

// TestCollectHandsTheDefaultPathItsTimeoutBudget pins the budget the
// subprocess path used to apply. After the S5 flip the in-process runner is
// the only implementation, and an empty CommandOptions would leave a hung
// tool store with nothing to stop it (TOKENBOARD_CCUSAGE_TIMEOUT_MS would
// silently stop meaning anything).
func TestCollectHandsTheDefaultPathItsTimeoutBudget(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "amp", "threads"), 0o700); err != nil {
		t.Fatal(err)
	}
	env := func(key string) string {
		if key == "AMP_DATA_DIR" {
			return filepath.Join(home, "amp")
		}
		return ""
	}
	// A one-millisecond budget over a real (if empty) scan: the run must come
	// back either with data or with the budget's own timeout line, never with
	// no deadline at all. The stub runner sees the options Collect built.
	var seen ccusage.CommandOptions
	_, err := Collect(context.Background(), contract.Source("amp"), Options{
		Env: env,
		Runner: func(_ context.Context, _ string, _ []string, options ccusage.CommandOptions) (any, error) {
			seen = options
			return map[string]any{"daily": []any{}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen.TimeoutMs != DefaultCcusageTimeoutMs {
		t.Errorf("TimeoutMs = %d, want the %d default", seen.TimeoutMs, DefaultCcusageTimeoutMs)
	}

	seen = ccusage.CommandOptions{}
	if _, err := Collect(context.Background(), contract.Source("amp"), Options{
		Env: func(key string) string {
			if key == "TOKENBOARD_CCUSAGE_TIMEOUT_MS" {
				return "1234"
			}
			return env(key)
		},
		Runner: func(_ context.Context, _ string, _ []string, options ccusage.CommandOptions) (any, error) {
			seen = options
			return map[string]any{"daily": []any{}}, nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	if seen.TimeoutMs != 1234 {
		t.Errorf("TimeoutMs = %d, want the TOKENBOARD_CCUSAGE_TIMEOUT_MS override", seen.TimeoutMs)
	}
}

// TestTheRegistryBuildsNoNativeSourceFromTheCallersRunner is the structural
// half of the S5 gate. An empty home keeps TestNativeToolsAreTheDefaultPath
// honest but cannot see a provider that grew a second, subprocess-shaped branch
// for the registry path. This test fails on any production file in these three
// providers that names the exported Runner option, so a regression has to
// either delete this check or stop reaching for that seam.
func TestTheRegistryBuildsNoNativeSourceFromTheCallersRunner(t *testing.T) {
	for _, dir := range []string{"..", "../codex", "."} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, name), nil, 0)
			if err != nil {
				t.Fatalf("%s: %v", filepath.Join(dir, name), err)
			}
			for _, decl := range file.Decls {
				funcDecl, ok := decl.(*ast.FuncDecl)
				if !ok || funcDecl.Recv == nil {
					continue
				}
				// The registry entry point hands the caller's Options through
				// and never looks at Runner, which exists for tests.
				method := funcDecl.Name.Name
				ast.Inspect(funcDecl.Body, func(node ast.Node) bool {
					switch expression := node.(type) {
					case *ast.SelectorExpr:
						if expression.Sel.Name == "Runner" {
							t.Errorf("%s: %s reads Options.Runner; the registry path must be the native "+
								"implementation only", filepath.Join(dir, name), method)
						}
					case *ast.KeyValueExpr:
						if key, ok := expression.Key.(*ast.Ident); ok && key.Name == "Runner" {
							t.Errorf("%s: %s fills in Runner; the registry path must be the native "+
								"implementation only", filepath.Join(dir, name), method)
						}
					}
					return true
				})
			}
		}
	}
}
