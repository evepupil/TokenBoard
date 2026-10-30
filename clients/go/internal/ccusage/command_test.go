package ccusage

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The TS command.test.ts runs these against the Node binary; the Go port uses
// the test binary's own helper-process trick (os.Args[0] with a flag) so the
// behavior — not the interpreter — is what the assertions pin.

// helperCommand returns the command and base args that re-execute this test
// binary as the fixture script named by the first argument.
func helperCommand(t *testing.T) (string, []string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe, []string{"-test.run=TestCommandHelperProcess", "--"}
}

// TestCommandHelperProcess is not a real test: it is the fixture body the
// command tests spawn. It only acts when invoked with the -- sentinel.
func TestCommandHelperProcess(t *testing.T) {
	if len(os.Args) == 0 {
		return
	}
	sentinel := -1
	for index, arg := range os.Args {
		if arg == "--" {
			sentinel = index
			break
		}
	}
	if sentinel < 0 || sentinel+1 >= len(os.Args) {
		return
	}
	script := os.Args[sentinel+1]
	scriptArgs := os.Args[sentinel+2:]
	switch script {
	case "echo-argv":
		payload := `{"argv":[`
		for index, arg := range scriptArgs {
			if index > 0 {
				payload += ","
			}
			payload += jsonQuote(arg)
		}
		payload += `]}`
		os.Stdout.WriteString(payload + "\n")
	case "sleep-then-print":
		delay, _ := time.ParseDuration(scriptArgs[0])
		time.Sleep(delay)
		os.Stdout.WriteString(`{"ok":true}` + "\n")
	case "sleep-forever":
		time.Sleep(time.Minute)
	case "stderr-then-sleep":
		os.Stderr.WriteString("partial diagnostics\n")
		time.Sleep(time.Minute)
	case "retry-once":
		attemptsPath := scriptArgs[0]
		attempts := 0
		if data, err := os.ReadFile(attemptsPath); err == nil {
			for _, b := range data {
				if b >= '0' && b <= '9' {
					attempts = attempts*10 + int(b-'0')
				}
			}
		}
		os.WriteFile(attemptsPath, []byte(string(rune('0'+attempts+1))), 0o600)
		if attempts < 1 {
			os.Stderr.WriteString("fetch failed\n")
			os.Exit(1)
		}
		os.Stdout.WriteString(`{"ok":true}` + "\n")
	case "echo-env":
		// Reports the credential variables as seen by the child, so the test can
		// assert they were stripped rather than merely absent from the caller's map.
		payload := `{"token":` + jsonQuote(os.Getenv("TOKENBOARD_UPLOAD_TOKEN")) +
			`,"pairing":` + jsonQuote(os.Getenv("TOKENBOARD_PAIRING_CODE")) +
			`,"releaseBaseUrl":` + jsonQuote(os.Getenv("TOKENBOARD_RELEASE_BASE_URL")) +
			`,"repoUrl":` + jsonQuote(os.Getenv("TOKENBOARD_REPO_URL")) +
			`,"kept":` + jsonQuote(os.Getenv("TOKENBOARD_STATE_DIR")) + `}`
		os.Stdout.WriteString(payload + "\n")
	case "fail-nontransient":
		os.Stderr.WriteString("invalid input\n")
		os.Exit(1)
	case "invalid-json":
		os.Stdout.WriteString("not json\n")
	}
	os.Exit(0)
}

func jsonQuote(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return `"` + replacer.Replace(value) + `"`
}

func TestRunJSONPassesArgumentsDirectlyWithoutShellParsing(t *testing.T) {
	command, args := helperCommand(t)
	result, err := RunJSON(context.Background(), command, append(args, "echo-argv", "value with spaces", "a&b", "$HOME"), CommandOptions{
		TimeoutMs:  30_000,
		RetryDelay: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, ok := result.(*orderedRecord)
	if !ok {
		t.Fatalf("result = %T", result)
	}
	argvValue, _ := record.Get("argv")
	argv, ok := argvValue.([]any)
	if !ok || len(argv) != 3 {
		t.Fatalf("argv = %v", argvValue)
	}
	expected := []string{"value with spaces", "a&b", "$HOME"}
	for index, want := range expected {
		if argv[index] != want {
			t.Errorf("argv[%d] = %v, want %q", index, argv[index], want)
		}
	}
}

// The timeout must be named so the scheduled log explains itself; Node's raw
// kill error reads exactly like a tool exiting non-zero.
// On a machine with no bundled ccusage binary the command is `npx`/`pnpm dlx`, which
// downloads and executes a third-party package. That package must not inherit the upload
// token: it authorizes writes as this device, and nothing ccusage does needs it.
//
// An empty Env means "inherit the process environment" in exec.Cmd, which is exactly the
// case that used to leak: the token is in the parent's environment, not in the caller's
// slice, so the test sets it in the parent and passes no Env at all.
func TestRunJSONStripsCredentialVariablesFromTheChildEnvironment(t *testing.T) {
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "tb_upload_must_not_leak")
	t.Setenv("TOKENBOARD_PAIRING_CODE", "tb_pair_must_not_leak")
	t.Setenv("TOKENBOARD_RELEASE_BASE_URL", "https://user:tb_release_must_not_leak@feed.example")
	t.Setenv("TOKENBOARD_REPO_URL", "https://user:tb_repo_must_not_leak@git.example/mirror.git")
	t.Setenv("TOKENBOARD_STATE_DIR", "/tmp/kept-for-the-child")

	command, args := helperCommand(t)
	result, err := RunJSON(context.Background(), command, append(args, "echo-env"), CommandOptions{
		TimeoutMs:  30_000,
		RetryDelay: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, ok := result.(*orderedRecord)
	if !ok {
		t.Fatalf("result = %T", result)
	}
	for name, want := range map[string]string{
		"token":          "",
		"pairing":        "",
		"releaseBaseUrl": "",
		"repoUrl":        "",
		"kept":           "/tmp/kept-for-the-child",
	} {
		value, _ := record.Get(name)
		if value != want {
			t.Errorf("%s = %v, want %q", name, value, want)
		}
	}
}

func TestRunJSONNamesTheTimeoutWhenTheBudgetIsExceeded(t *testing.T) {
	command, args := helperCommand(t)
	_, err := RunJSON(context.Background(), command, append(args, "sleep-then-print", "200ms"), CommandOptions{
		TimeoutMs:  20,
		RetryDelay: time.Millisecond,
	})
	if err == nil {
		t.Fatal("expected a timeout failure")
	}
	if !strings.HasPrefix(err.Error(), "Command timed out after 20ms: ") {
		t.Errorf("err = %q", err.Error())
	}
}

func TestRunJSONOmitsStderrLineWhenKilledChildWroteNone(t *testing.T) {
	command, args := helperCommand(t)
	_, err := RunJSON(context.Background(), command, append(args, "sleep-forever"), CommandOptions{
		TimeoutMs:  60,
		RetryDelay: time.Millisecond,
	})
	if err == nil {
		t.Fatal("expected a timeout failure")
	}
	if strings.Contains(err.Error(), "\n") {
		t.Errorf("timeout message must not carry an empty stderr line: %q", err.Error())
	}
	if !strings.HasPrefix(err.Error(), "Command timed out after 60ms: ") {
		t.Errorf("err = %q", err.Error())
	}
}

// A killed child's stderr is not guaranteed to be captured (Node discards it),
// but when Go does capture it the message must still lead with the timeout.
func TestRunJSONStillNamesTheTimeoutWhenChildWroteStderr(t *testing.T) {
	command, args := helperCommand(t)
	_, err := RunJSON(context.Background(), command, append(args, "stderr-then-sleep"), CommandOptions{
		TimeoutMs:  60,
		RetryDelay: time.Millisecond,
	})
	if err == nil {
		t.Fatal("expected a timeout failure")
	}
	if !strings.HasPrefix(err.Error(), "Command timed out after 60ms: ") {
		t.Errorf("err = %q", err.Error())
	}
}

func TestDescribeCommandFailureLeavesNonTimeoutFailuresAlone(t *testing.T) {
	original := &commandError{message: "Command failed: tool exited 1", stderr: "boom"}
	described := describeCommandFailure(original, "tool", []string{"--x"}, 5)
	if !strings.Contains(described.Error(), "Command failed: tool exited 1") ||
		!strings.Contains(described.Error(), "boom") {
		t.Errorf("described = %q", described.Error())
	}
	plain := context.Canceled
	if got := describeCommandFailure(plain, "tool", nil, 5); got != plain {
		t.Errorf("non-command failures must pass through, got %v", got)
	}
}

func TestRunJSONRetriesTransientPackageDownloadFailuresBeforeSucceeding(t *testing.T) {
	dir := t.TempDir()
	attemptsPath := filepath.Join(dir, "attempts.txt")
	var retryLogs []string
	command, args := helperCommand(t)
	result, err := RunJSON(context.Background(), command, append(args, "retry-once", attemptsPath), CommandOptions{
		Retries:    2,
		RetryDelay: time.Millisecond,
		TimeoutMs:  30_000,
		OnRetry:    func(line string) { retryLogs = append(retryLogs, line) },
	})
	if err != nil {
		t.Fatal(err)
	}
	attempts, err := os.ReadFile(attemptsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(attempts) != "2" {
		t.Errorf("attempts = %q, want \"2\"", attempts)
	}
	record, _ := result.(*orderedRecord)
	if value, _ := record.Get("ok"); value != true {
		t.Errorf("result = %v", result)
	}
	if len(retryLogs) != 1 {
		t.Fatalf("retryLogs = %v", retryLogs)
	}
	if !strings.Contains(retryLogs[0], "fetch failed") {
		t.Errorf("retry line must carry the failure: %q", retryLogs[0])
	}
	if !strings.Contains(retryLogs[0], "Retrying command after transient failure (1/2)") {
		t.Errorf("retry line = %q", retryLogs[0])
	}
}

func TestRunJSONDoesNotRetryNonTransientCommandFailures(t *testing.T) {
	var retryLogs []string
	command, args := helperCommand(t)
	_, err := RunJSON(context.Background(), command, append(args, "fail-nontransient"), CommandOptions{
		Retries:    2,
		RetryDelay: time.Millisecond,
		TimeoutMs:  30_000,
		OnRetry:    func(line string) { retryLogs = append(retryLogs, line) },
	})
	if err == nil {
		t.Fatal("expected failure")
	}
	if len(retryLogs) != 0 {
		t.Errorf("retryLogs = %v", retryLogs)
	}
}

func TestRunJSONRejectsInvalidJSONOutput(t *testing.T) {
	command, args := helperCommand(t)
	_, err := RunJSON(context.Background(), command, append(args, "invalid-json"), CommandOptions{
		TimeoutMs:  30_000,
		RetryDelay: time.Millisecond,
	})
	if err == nil || !strings.Contains(err.Error(), "Command returned invalid JSON") {
		t.Fatalf("err = %v", err)
	}
}

func TestCommandShellOptionMatchesTSPlatformRules(t *testing.T) {
	cases := []struct {
		command string
		goos    string
		want    bool
	}{
		{"npm.cmd", "windows", true},
		{"pnpm.bat", "windows", true},
		{"pnpm", "windows", false},
		{"npm.cmd", "linux", false},
		{"NPM.CMD", "windows", true},
	}
	for _, tc := range cases {
		got, err := commandShellOptionFor(tc.command, tc.goos)
		if err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Errorf("commandShellOptionFor(%q, %q) = %v, want %v", tc.command, tc.goos, got, tc.want)
		}
	}
}

func TestAssertWindowsShellSafeInvocationRejectsMetacharacters(t *testing.T) {
	err := assertWindowsShellSafeInvocation("npm.cmd", []string{"exec", "ccusage", "--timezone", "UTC&whoami"})
	if err == nil || !strings.Contains(err.Error(), "Windows command argument 3") {
		t.Fatalf("err = %v", err)
	}
	if err := assertWindowsShellSafeInvocation("npm.cmd", []string{"exec", "ccusage", "--timezone", "Asia/Shanghai"}); err != nil {
		t.Errorf("legal args rejected: %v", err)
	}
}

func TestAssertWindowsShellSafeInvocationAllowsLegalParentheses(t *testing.T) {
	err := assertWindowsShellSafeInvocation("npm.cmd",
		[]string{"exec", "ccusage", "--input-dir", `C:\Program Files (x86)\TokenBoard`})
	if err != nil {
		t.Errorf("parenthesized path rejected: %v", err)
	}
}

func TestAssertWindowsShellSafeInvocationRejectsMetacharactersInShimPath(t *testing.T) {
	err := assertWindowsShellSafeInvocation("C:/tools/npm.cmd&whoami", nil)
	if err == nil || !strings.Contains(err.Error(), "Windows command shim path") {
		t.Fatalf("err = %v", err)
	}
	err = assertWindowsShellSafeInvocation("C:/Program Files (x86)/nodejs/npm.cmd",
		[]string{"exec", "ccusage", "--timezone", "Asia/Shanghai"})
	if err != nil {
		t.Errorf("parenthesized shim path rejected: %v", err)
	}
}

func TestBuildShellInvocationQuotesWindowsArguments(t *testing.T) {
	inv, err := buildShellInvocation("C:/Program Files (x86)/nodejs/npm.cmd",
		[]string{"exec", "ccusage", "--input-dir", "C:/checkouts/(repo) with spaces", `C:\work\`}, true)
	if err != nil {
		t.Fatal(err)
	}
	quotedLine := `""C:/Program Files (x86)/nodejs/npm.cmd" exec ccusage --input-dir "C:/checkouts/(repo) with spaces" "C:\work\\""`
	wantComspec := os.Getenv("ComSpec")
	if wantComspec == "" {
		wantComspec = "cmd.exe"
	}
	// SysProcAttr.CmdLine replaces the entire CreateProcess command line, so
	// the wrapper flags must be part of it. Passing only the quoted shim line
	// left cmd.exe with no /d /s /c and it tried to run `exec` as the program.
	wantCommandLine := wantComspec + " /d /s /c " + quotedLine
	if inv.windowsCmdLine != wantCommandLine {
		t.Errorf("windowsCmdLine = %q, want %q", inv.windowsCmdLine, wantCommandLine)
	}
	if inv.command != wantComspec {
		t.Errorf("command = %q, want %q", inv.command, wantComspec)
	}
	if len(inv.args) != 4 || inv.args[0] != "/d" || inv.args[1] != "/s" || inv.args[2] != "/c" ||
		inv.args[3] != quotedLine {
		t.Errorf("args = %v", inv.args)
	}
}

// The quoted-shim execution path only exists on Windows; keep the skip so the
// coverage intent from the TS suite is preserved.
func TestRunJSONRunsWindowsShimWithQuotedParenthesizedArguments(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-only execution path")
	}
	dir := t.TempDir()
	shim := filepath.Join(dir, "capture shim.cmd")
	printer := filepath.Join(dir, "capture-args.bat")
	argvFile := filepath.Join(dir, "argv.txt")
	// The payload must be valid JSON: the arguments contain a Windows path,
	// and a backslash inside a JSON string is an invalid escape — the client
	// would correctly refuse the output rather than run it.
	script := "@echo off\r\n" +
		"echo %* > \"" + argvFile + "\"\r\n" +
		"echo {}\r\n"
	if err := os.WriteFile(printer, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, []byte(`@echo off`+"\r\n"+`call "`+printer+`" %*`+"\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := RunJSON(context.Background(), shim,
		[]string{"alpha beta", `C:\Program Files (x86)\TokenBoard\`, "tail"},
		CommandOptions{TimeoutMs: 30_000, RetryDelay: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	// The argument with spaces and parentheses must survive the quoting: the
	// shim is invoked through cmd.exe, where an unquoted path would split.
	captured, readErr := os.ReadFile(argvFile)
	if readErr != nil {
		t.Fatalf("the shim did not capture its arguments: %v", readErr)
	}
	if !strings.Contains(string(captured), "alpha beta") ||
		!strings.Contains(string(captured), "C:\\Program Files (x86)\\TokenBoard\\") {
		t.Errorf("captured arguments = %q", string(captured))
	}
}

// TS reads both of these with Number.parseInt(…, 10): a trailing suffix is
// ignored. Atoi rejected those values and fell back to the defaults, so the
// two collectors used different budgets for the same environment.
func TestCommandEnvValuesReadLikeParseInt(t *testing.T) {
	timeouts := []struct {
		value string
		want  int
	}{
		{"5000", 5000},
		{"5000ms", 5000},
		{" 5000", 5000},
		{"5000.9", 5000},
		{"0", DefaultCommandTimeoutMs},
		{"-1", DefaultCommandTimeoutMs},
		{"abc", DefaultCommandTimeoutMs},
	}
	for _, tc := range timeouts {
		t.Setenv("TOKENBOARD_COMMAND_TIMEOUT_MS", tc.value)
		if got := readCommandTimeoutMs(); got != tc.want {
			t.Errorf("readCommandTimeoutMs(%q) = %d, want %d", tc.value, got, tc.want)
		}
	}

	delays := []struct {
		value string
		want  time.Duration
	}{
		{"250", 250 * time.Millisecond},
		{"250ms", 250 * time.Millisecond},
		{"250.9", 250 * time.Millisecond},
		{"0", 0},
		{"-1", DefaultRetryDelayMs * time.Millisecond},
		{"abc", DefaultRetryDelayMs * time.Millisecond},
	}
	for _, tc := range delays {
		t.Setenv("TOKENBOARD_COMMAND_RETRY_DELAY_MS", tc.value)
		if got := readRetryDelay(); got != tc.want {
			t.Errorf("readRetryDelay(%q) = %v, want %v", tc.value, got, tc.want)
		}
	}
}

// A tool that floods stderr must fail the run rather than buffer without limit:
// the stream carries diagnostics, and an unbounded buffer is how a runaway child
// turns into an out-of-memory kill of the collector itself.
func TestLimitedWriterRefusesToBufferPastItsLimit(t *testing.T) {
	var buffer bytes.Buffer
	writer := &limitedWriter{buffer: &buffer, limit: 8}
	if _, err := writer.Write([]byte("12345678")); err != nil {
		t.Fatalf("write at the limit: %v", err)
	}
	if _, err := writer.Write([]byte("9")); err == nil {
		t.Fatal("write past the limit must fail")
	} else if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("error = %v, want an 'exceeded' message", err)
	}
	if buffer.Len() != 8 {
		t.Fatalf("buffer = %d bytes, want the pre-limit content preserved", buffer.Len())
	}
}
