package ccusage

// The split gate for S5 (2026-11-10): internal/ccusage is the shared contract
// the native providers and self-update depend on - report decoding,
// normalization, the ordered JSON records, the credential scrub and the
// report-source seam. The acquisition and execution subpackages are deleted;
// this test fails if a helper that reaches a binary grows back in here.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// sharedExports is every name internal/ccusage may export after the split.
// Adding one here is a deliberate change to the shared contract; a new
// acquisition helper belongs in the subpackage instead.
var sharedExports = map[string]bool{
	// normalize.go
	"DecodeJSON":                    true,
	"DecodeJSONValue":               true,
	"NormalizeCcusageDailyJSON":     true,
	"ReadCcusageSessionAttribution": true,
	"SessionAttribution":            true,
	"NormalizeOptions":              true,
	// normalize.go's report-shape helpers the native adapters answer with.
	"HasDailyRows":       true,
	"SessionRows":        true,
	"ReadSessionFileRow": true,
	// orderedjson.go
	"DecodeOrderedJSON": true,
	"OrderedObject":     true,
	"RecordGet":         true,
	"RecordWith":        true,
	// credentials.go
	"ScrubCredentialEnv": true,
	// report.go: the report-source seam every provider calls. It names a
	// report shape, not a binary; the acquisition and execution layers that
	// used to back it are gone.
	"CommandOptions": true,
	"CommandRunner":  true,
	"ReportCommand":  true,
	"WithConfigArgs": true,
}

func TestCcusageCoreKeepsOnlySharedContracts(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	found := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if file.Name.Name != "ccusage" {
			// A non-ccusage package in this directory belongs to a subpackage
			// that os.ReadDir already lists as a directory.
			t.Fatalf("%s declares package %q, want ccusage", name, file.Name.Name)
		}
		for _, declaration := range file.Decls {
			switch typed := declaration.(type) {
			case *ast.FuncDecl:
				if typed.Recv == nil && typed.Name.IsExported() {
					found[typed.Name.Name] = true
				}
			case *ast.GenDecl:
				if typed.Tok != token.TYPE && typed.Tok != token.CONST && typed.Tok != token.VAR {
					continue
				}
				for _, spec := range typed.Specs {
					switch spec := spec.(type) {
					case *ast.TypeSpec:
						if spec.Name.IsExported() {
							found[spec.Name.Name] = true
						}
					case *ast.ValueSpec:
						for _, ident := range spec.Names {
							if ident.IsExported() {
								found[ident.Name] = true
							}
						}
					}
				}
			}
		}
	}
	for name := range found {
		if !sharedExports[name] {
			t.Errorf("internal/ccusage exports %q; acquisition belongs in internal/ccusage/{acquire,exec,runner}, "+
				"and a new shared contract has to be added to sharedExports deliberately", name)
		}
	}
	for name := range sharedExports {
		if !found[name] {
			t.Errorf("sharedExports lists %q but internal/ccusage no longer exports it", name)
		}
	}
}

// TestCcusageCoreImportsNoNetworkOrProcessPackages pins the other half of the
// split: a package that only decodes and normalizes reports has no business
// opening sockets or spawning processes.
func TestCcusageCoreImportsNoNetworkOrProcessPackages(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	forbidden := map[string]bool{"net/http": true, "os/exec": true, "archive/tar": true, "compress/gzip": true}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, spec := range file.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if forbidden[path] {
				t.Errorf("%s imports %q; the client no longer acquires or spawns a ccusage binary", name, path)
			}
		}
	}
}
