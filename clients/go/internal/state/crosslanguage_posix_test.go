package state

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The lock file is a cross-language contract: the skill's coordinator-lock.mjs
// takes the same self-update.lock in the same directory. If Go writes a record
// the skill cannot read as a live owner, both sides enter the update path at
// once and can delete each other's staged binary. This drives the real
// coordinator-lock.mjs against a lock this process holds.
func TestSkillLockYieldsToAGoHeldLock(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the probe spawns node with a POSIX path; covered on the TS side")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(dir, "self-update.lock")

	lock, err := Acquire(lockPath, time.Second)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if lock == nil {
		t.Fatal("could not take the lock for the test")
	}
	defer func() { _ = lock.Release() }()

	// The holder's record is readable and names this live process.
	raw, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("read lock: %v", err)
	}
	var record LockOwner
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatalf("the record is not valid JSON the skill can parse: %v", err)
	}
	if record.PID != os.Getpid() || record.Token == "" {
		t.Fatalf("record = %+v, want this process's pid and a token", record)
	}

	script := `
import { acquireLock } from './skills/tokenboard/scripts/coordinator-lock.mjs'
import { stateLockRuntime } from './skills/tokenboard/scripts/state-lock-runtime.mjs'
const runtime = stateLockRuntime({ lockTimeoutMs: 0 })
const lock = acquireLock(process.argv[1], runtime)
console.log(lock ? 'ACQUIRED' : 'BLOCKED')
`
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--input-type=module", "-e", script, lockPath)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "BLOCKED") {
		t.Fatalf("the skill took a lock Go holds: %s", output)
	}
}
