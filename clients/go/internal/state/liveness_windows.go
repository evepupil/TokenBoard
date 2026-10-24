//go:build windows

package state

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// platformSignalZero probes existence via tasklist: signal 0 is unreliable
// for other processes' pids on Windows, so existence is answered by listing
// the pid, mirroring probeWindowsProcess.
func platformSignalZero(pid int) error {
	out, err := tasklistOutput(pid)
	if err != nil {
		return err
	}
	if !tasklistContainsPid(out, pid) {
		return fmt.Errorf("tasklist: %w", errProcessGone)
	}
	return nil
}

// platformProcessStartIdentity degrades on Windows: the verbose CSV has no
// creation-time column, so identity is unavailable and stale detection runs
// on liveness alone (the TS side's documented degradation).
func platformProcessStartIdentity(int) (string, error) {
	return "", errors.New("identity unsupported on windows")
}

// tasklistTimeout bounds the probe. Without it a `tasklist` that blocks — EDR
// interference, a policy prompt, a loaded machine — hangs the caller forever,
// and the caller is the stale-lock check: the lock's own timeout would stop
// protecting anything because this path never returns. TS bounds the same probe
// at 2 s; a timeout here means "liveness unknown", which the caller treats the
// same way as an unanswered probe.
const tasklistTimeout = 2 * time.Second

func tasklistOutput(pid int) (string, error) {
	systemRoot := "C:\\Windows"
	if root := strings.TrimSpace(osGetenv("SystemRoot")); root != "" {
		systemRoot = root
	}
	tasklist := systemRoot + "\\System32\\tasklist.exe"
	ctx, cancel := context.WithTimeout(context.Background(), tasklistTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, tasklist, "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH")
	cmd.SysProcAttr = hideWindow()
	// A killed child leaves its pipes open until the OS reaps it; WaitDelay keeps
	// Output from blocking on them after the deadline.
	cmd.WaitDelay = tasklistTimeout
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func tasklistContainsPid(output string, pid int) bool {
	for _, line := range strings.Split(output, "\r\n") {
		if strings.Contains(line, fmt.Sprintf(`","%d"`, pid)) || strings.Contains(line, fmt.Sprintf(`","%d",`, pid)) {
			return true
		}
	}
	return false
}

func hideWindow() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
