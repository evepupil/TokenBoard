package antigravitygui

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The language server is a third-party binary that the client launches with
// exec.Cmd, which inherits the whole process environment when Env is nil. The
// upload token lives there. A stand-in script records whether it could see it.
func TestSpawnLanguageServerScrubsTheCredentialEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in is a POSIX shell script")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "seen.txt")
	script := filepath.Join(dir, "server.sh")
	body := "#!/bin/sh\nif [ -n \"$TOKENBOARD_UPLOAD_TOKEN\" ]; then echo LEAKED > " + marker +
		"; else echo CLEAN > " + marker + "; fi\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "tb_probe_secret")

	server, err := spawnLanguageServer(Options{Source: string(contract.SourceAntigravity)}, script, "", 12345, "csrf")
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	// close() signals immediately and the shell may not have written yet, so
	// wait for the child to finish on its own before reading the marker.
	select {
	case <-server.exited:
	case <-time.After(5 * time.Second):
		_ = server.close()
		t.Fatal("the stand-in did not finish")
	}

	seen, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("the stand-in never ran: %v", err)
	}
	if strings.TrimSpace(string(seen)) != "CLEAN" {
		t.Fatalf("the language server inherited the upload token: %q", seen)
	}
}
