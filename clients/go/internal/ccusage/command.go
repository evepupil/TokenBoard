package ccusage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of command.ts. The messages are load-bearing: a timeout is named as a
// timeout (Node's bare "Command failed" once made a busy-machine sync look like
// a tool defect), and retries print the TS retry line so the scheduled log
// reads the same whichever implementation produced it.

// DefaultCommandTimeoutMs is the generic command budget (command.ts).
const DefaultCommandTimeoutMs = 120_000

// DefaultRetryDelayMs is the pause between transient retries.
const DefaultRetryDelayMs = 5_000

// maxBufferBytes mirrors execFile's maxBuffer: a runaway ccusage run must fail
// instead of exhausting memory.
const maxBufferBytes = 128 * 1024 * 1024

// maxStderrBytes bounds the diagnostics stream. It matches maxBufferBytes so the
// ceiling a caller sees is the same whichever stream the tool floods; the point is
// that the ceiling exists at all, which it did not while stderr was a bare buffer.
const maxStderrBytes = maxBufferBytes

// CommandOptions configures one run.
type CommandOptions struct {
	Env        []string
	TimeoutMs  int
	Retries    int
	RetryDelay time.Duration
	OnRetry    func(line string)
}

// CommandRunner runs a command and decodes its JSON stdout. It is a function
// type so a provider can substitute a stub, exactly like the TS CommandRunner.
type CommandRunner func(ctx context.Context, command string, args []string, options CommandOptions) (any, error)

// RunJSON is the production runner.
func RunJSON(ctx context.Context, command string, args []string, options CommandOptions) (any, error) {
	retries := options.Retries
	if retries < 0 {
		retries = 0
	}
	if options.RetryDelay == 0 {
		options.RetryDelay = readRetryDelay()
	}
	timeout := options.TimeoutMs
	if timeout <= 0 {
		timeout = readCommandTimeoutMs()
	}
	shell, err := commandShellOption(command)
	if err != nil {
		return nil, err
	}
	invocation, err := buildShellInvocation(command, args, shell)
	if err != nil {
		return nil, err
	}

	attempts := retries + 1
	for attempt := 1; attempt <= attempts; attempt++ {
		output, runErr := runOnce(ctx, invocation, options.Env, timeout)
		if runErr == nil {
			// Decode with the ordered reader: ccusage's breakdown objects are
			// iterated in document order, and JSON.parse (the TS runner) keeps
			// that order too. encoding/json's maps would sort it away.
			decoded, err := decodeOrdered(output)
			if err != nil {
				return nil, fmt.Errorf("Command returned invalid JSON: %v", err)
			}
			return decoded, nil
		}
		failure := describeCommandFailure(runErr, command, args, timeout)
		if attempt >= attempts || !collect.IsTransientNetworkError(failure) {
			return nil, failure
		}
		if options.OnRetry != nil {
			options.OnRetry(fmt.Sprintf(
				"Retrying command after transient failure (%d/%d): %s", attempt, retries, failure.Error()))
		}
		if err := sleepContext(ctx, options.RetryDelay); err != nil {
			return nil, failure
		}
	}
	return nil, fmt.Errorf("Command failed without a result: %s", command)
}

type invocation struct {
	command string
	args    []string
	shell   bool
	// windowsCmdLine is the pre-quoted command line for the cmd.exe wrapper
	// (Node's windowsVerbatimArguments: true).
	windowsCmdLine string
}

// runOnce executes one attempt. A timeout surfaces as a killed process with a
// synthesized message; the caller's describeCommandFailure names it.
func runOnce(ctx context.Context, inv invocation, env []string, timeoutMs int) ([]byte, error) {
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(runCtx, inv.command, inv.args...)
	// Every ccusage spawn goes through here, so stripping at this point is the
	// one place that cannot be forgotten by a new provider. An empty env means
	// "inherit", which is exactly the case that leaks the upload token.
	cmd.Env = scrubCredentialEnv(env)
	if inv.windowsCmdLine != "" {
		cmd.SysProcAttr = verbatimProcessAttr(inv.windowsCmdLine)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buffer: &stdout, limit: maxBufferBytes}
	// stderr carries diagnostics, not the report, so it is bounded the same way but
	// with a larger ceiling: a runaway tool must not be able to drive the collector's
	// RSS up without limit. The TS side's execFile maxBuffer covers both streams, so
	// leaving this one uncapped was also a cross-client divergence.
	cmd.Stderr = &limitedWriter{buffer: &stderr, limit: maxStderrBytes}
	// A killed child must not leave grandchildren holding the pipes: wait for
	// the process itself, not for output EOF.
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if runCtx.Err() == context.DeadlineExceeded {
		return nil, &timeoutError{stderr: strings.TrimSpace(stderr.String())}
	}
	if err != nil {
		return nil, &commandError{message: err.Error(), stderr: strings.TrimSpace(stderr.String())}
	}
	if stdout.Len() >= maxBufferBytes {
		return nil, fmt.Errorf("Command output exceeded the %d-byte buffer limit", maxBufferBytes)
	}
	return stdout.Bytes(), nil
}

type timeoutError struct{ stderr string }

func (e *timeoutError) Error() string { return "command timed out" }

type commandError struct {
	message string
	stderr  string
}

func (e *commandError) Error() string { return e.message }

// describeCommandFailure names a timeout the way command.ts does, carrying any
// stderr the kill left behind; every other failure keeps its own message with
// the stderr appended so the transient classifier sees transport signatures.
func describeCommandFailure(err error, command string, args []string, timeoutMs int) error {
	var timeout *timeoutError
	if errors.As(err, &timeout) {
		message := fmt.Sprintf("Command timed out after %dms: %s", timeoutMs, strings.Join(append([]string{command}, args...), " "))
		if timeout.stderr != "" {
			message += "\n" + timeout.stderr
		}
		return errors.New(message)
	}
	var failure *commandError
	if errors.As(err, &failure) && failure.stderr != "" {
		return errors.New(failure.message + "\n" + failure.stderr)
	}
	return err
}

// commandShellOption mirrors commandShellOption: on Windows a .cmd/.bat shim
// cannot be executed directly, so it is run through cmd.exe with a pre-quoted
// command line.
func commandShellOption(command string) (bool, error) {
	return commandShellOptionFor(command, runtime.GOOS)
}

func commandShellOptionFor(command, goos string) (bool, error) {
	if goos != "windows" {
		return false, nil
	}
	lower := strings.ToLower(command)
	return strings.HasSuffix(lower, ".cmd") || strings.HasSuffix(lower, ".bat"), nil
}

// buildShellInvocation quotes the whole command line for cmd.exe, refusing
// shell metacharacters first: a quoted argument is still evaluated by cmd.exe,
// so `&` inside one would run a second command.
func buildShellInvocation(command string, args []string, shell bool) (invocation, error) {
	if !shell {
		return invocation{command: command, args: args}, nil
	}
	if err := assertWindowsShellSafeInvocation(command, args); err != nil {
		return invocation{}, err
	}
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, quoteWindowsShellArgument(command))
	for _, arg := range args {
		parts = append(parts, quoteWindowsShellArgument(arg))
	}
	commandLine := strings.Join(parts, " ")
	if strings.HasPrefix(commandLine, `"`) {
		commandLine = `"` + commandLine + `"`
	}
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	// SysProcAttr.CmdLine replaces the whole CreateProcess command line, not
	// just the argument tail (syscall/exec_windows.go: "use attr.CmdLine if
	// set, else build the command line by escaping the arguments"). Passing
	// only the quoted shim line would hand cmd.exe a command line with no
	// `/d /s /c`, and it would try to run `exec` as the program. The wrapper
	// flags therefore belong in the verbatim line itself.
	wrapperArgs := []string{comspec, "/d", "/s", "/c", commandLine}
	return invocation{
		command:        comspec,
		args:           wrapperArgs[1:],
		windowsCmdLine: strings.Join(wrapperArgs, " "),
	}, nil
}

// windowsShellMetacharacters are the operators cmd.exe still evaluates inside
// a quoted argument. Parentheses are allowed: they are valid inside quoted
// arguments and in paths such as "Program Files (x86)".
func windowsShellMetacharacters(arg string) bool {
	return strings.ContainsAny(arg, "&|<>^%!\"\r\n")
}

func assertWindowsShellSafeInvocation(command string, args []string) error {
	if windowsShellMetacharacters(command) {
		return errors.New("Refusing to pass shell metacharacters in a Windows command shim path")
	}
	for index, arg := range args {
		if windowsShellMetacharacters(arg) {
			return fmt.Errorf("Refusing to pass shell metacharacters in Windows command argument %d", index)
		}
	}
	return nil
}

// quoteWindowsShellArgument quotes an argument for cmd.exe: empty strings,
// whitespace, parentheses and trailing backslashes need quotes.
func quoteWindowsShellArgument(value string) string {
	if value == "" || strings.ContainsAny(value, " \t()") || strings.HasSuffix(value, "\\") {
		trailing := 0
		for i := len(value) - 1; i >= 0 && value[i] == '\\'; i-- {
			trailing++
		}
		return `"` + value + strings.Repeat(`\`, trailing) + `"`
	}
	return value
}

func readCommandTimeoutMs() int {
	// parseInt semantics, matching TS: a trailing suffix still yields a
	// usable value.
	if value, ok := contract.ParseInt(os.Getenv("TOKENBOARD_COMMAND_TIMEOUT_MS")); ok && value > 0 {
		return value
	}
	return DefaultCommandTimeoutMs
}

func readRetryDelay() time.Duration {
	if value, ok := contract.ParseInt(os.Getenv("TOKENBOARD_COMMAND_RETRY_DELAY_MS")); ok && value >= 0 {
		return time.Duration(value) * time.Millisecond
	}
	return DefaultRetryDelayMs * time.Millisecond
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// limitedWriter fails the run rather than buffering unbounded output. The
// error surfaces through cmd.Run; the buffer cap is checked by the caller too.
type limitedWriter struct {
	buffer *bytes.Buffer
	limit  int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.buffer.Len()+len(p) > w.limit {
		return 0, fmt.Errorf("output exceeded %d bytes", w.limit)
	}
	return w.buffer.Write(p)
}
