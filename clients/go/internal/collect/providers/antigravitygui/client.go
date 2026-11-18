package antigravitygui

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The language server's fixed endpoints and timeouts, matching the TS client.
const (
	defaultLanguageServerPath = "/Applications/Antigravity.app/Contents/Resources/bin/language_server"
	apiServerURL              = "https://generativelanguage.googleapis.com"
	cloudCodeEndpoint         = "https://daily-cloudcode-pa.googleapis.com"
	defaultReadyTimeout       = 30 * time.Second
	requestTimeout            = 60 * time.Second
	// A real metadata response can include a large but bounded trajectory.
	maxMetadataResponseBytes = 32 * 1024 * 1024
	readyProbeInterval       = 100 * time.Millisecond
	readyProbeTimeout        = 1 * time.Second
)

// GeneratorMetadataRequest names one conversation to ask the server about.
type GeneratorMetadataRequest struct {
	Source    Source
	CascadeID string
}

// LanguageServerClient talks to one running Antigravity language server.
type LanguageServerClient struct {
	RequestGeneratorMetadata func(request GeneratorMetadataRequest) (any, error)
	Close                    func() error
}

// CreateLanguageServerClient spawns the language server and waits for it to
// answer on its local HTTPS port.
func CreateLanguageServerClient(options Options, languageServerPath, overrideIdeVersion string, port int) (*LanguageServerClient, error) {
	if port == 0 {
		allocated, err := allocatePort()
		if err != nil {
			return nil, err
		}
		port = allocated
	}
	csrfToken, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	server, err := spawnLanguageServer(options, languageServerPath, overrideIdeVersion, port, csrfToken)
	if err != nil {
		return nil, err
	}
	if err := server.waitForReady(port, probeLanguageServerEndpoint); err != nil {
		_ = server.close()
		return nil, err
	}
	return &LanguageServerClient{
		RequestGeneratorMetadata: func(request GeneratorMetadataRequest) (any, error) {
			return RequestGeneratorMetadata(request, port, csrfToken)
		},
		Close: func() error { return server.close() },
	}, nil
}

// SpawnLanguageServerError reports a language server that could not be
// started at all.
type SpawnLanguageServerError struct {
	Message string
	Cause   error
}

func (e *SpawnLanguageServerError) Error() string { return e.Message }
func (e *SpawnLanguageServerError) Unwrap() error { return e.Cause }

// languageServerProcess owns the child and its single Wait call. Wait must run
// exactly once, and the reaper goroutine here is the only caller, so the exit
// signal is available whether the process dies during startup or later.
type languageServerProcess struct {
	command *exec.Cmd
	exited  chan struct{}
	waitErr error
}

func spawnLanguageServer(options Options, languageServerPath, overrideIdeVersion string, port int, csrfToken string) (*languageServerProcess, error) {
	path := languageServerPath
	if path == "" {
		path = os.Getenv("TOKENBOARD_ANTIGRAVITY_LANGUAGE_SERVER")
	}
	if path == "" {
		path = defaultLanguageServerPath
	}
	if overrideIdeVersion == "" {
		overrideIdeVersion = "0.0.0"
	}
	subclientType := "hub"
	if options.Source == "antigravity-ide" {
		subclientType = "ide"
	}
	args := []string{
		"--standalone",
		"--override_ide_name", string(options.Source),
		"--subclient_type", subclientType,
		"--override_ide_version", overrideIdeVersion,
		"--override_user_agent_name", string(options.Source),
		"--https_server_port", strconv.Itoa(port),
		"--csrf_token", csrfToken,
		"--app_data_dir", string(options.Source),
		"--api_server_url", apiServerURL,
		"--cloud_code_endpoint", cloudCodeEndpoint,
		"--enable_sidecars",
		"--headless",
	}
	command := exec.Command(path, args...)
	// The language server is a third-party binary, and exec.Cmd inherits the
	// whole process environment when Env is nil — upload token included. Use
	// the same scrubbed list every other third-party child gets.
	command.Env = ccusage.ScrubCredentialEnv(nil)
	// The server writes progress to stdout/stderr that nobody reads; discarding
	// it keeps a chatty run from filling a pipe buffer and blocking the child.
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	command.Stdin = nil
	if err := command.Start(); err != nil {
		// A missing binary is "the language server is not installed here",
		// which the availability classifier and the TS log contract both
		// recognize as `spawn <path> … ENOENT`; Go's exec error does not read
		// that way, so it is rewrapped. A bare command name resolves through
		// PATH and reports exec.ErrNotFound (also fs.ErrNotExist) with no
		// *PathError, so this branch covers both shapes.
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
			return nil, &SpawnLanguageServerError{
				Message: "spawn " + path + " ENOENT",
				Cause:   err,
			}
		}
		return nil, err
	}
	process := &languageServerProcess{command: command, exited: make(chan struct{})}
	go func() {
		process.waitErr = command.Wait()
		close(process.exited)
	}()
	return process, nil
}

// probeFunc reports whether the server is answering yet.
type probeFunc func(port int) error

func (p *languageServerProcess) waitForReady(port int, probe probeFunc) error {
	deadline := time.Now().Add(readReadyTimeout())
	for {
		select {
		case <-p.exited:
			return errors.New("Antigravity language server exited before it was ready")
		default:
		}
		if err := probe(port); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Timed out starting Antigravity language server on port %d", port)
		}
		select {
		case <-p.exited:
			return errors.New("Antigravity language server exited before it was ready")
		case <-time.After(readyProbeInterval):
		}
	}
}

func readReadyTimeout() time.Duration {
	// TS reads this with Number.parseInt(…, 10); Atoi would reject the
	// trailing-suffix forms parseInt accepts and fall back to the default.
	if value, ok := contract.ParseInt(os.Getenv("TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS")); ok && value > 0 {
		return time.Duration(value) * time.Millisecond
	}
	return defaultReadyTimeout
}

// probeLanguageServerEndpoint opens a TLS connection to the local port. The
// server uses a self-signed certificate, so verification is deliberately off —
// the connection never leaves the loopback interface.
func probeLanguageServerEndpoint(port int) error {
	dialer := &net.Dialer{Timeout: readyProbeTimeout}
	connection, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), &tls.Config{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return err
	}
	return connection.Close()
}

// RequestGeneratorMetadata asks the server for one conversation's generator
// metadata. The response is returned as decoded JSON for the parser.
func RequestGeneratorMetadata(request GeneratorMetadataRequest, port int, csrfToken string) (any, error) {
	body, err := json.Marshal(map[string]string{"cascadeId": request.CascadeID})
	if err != nil {
		return nil, err
	}
	client := &http.Client{
		Timeout: requestTimeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		// The TS request() never follows a redirect: a 3xx is just a non-200
		// status. Following one would hand the loopback CSRF token to
		// whatever host the response names.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	httpRequest, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("https://127.0.0.1:%d/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata", port),
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Connect-Protocol-Version", "1")
	httpRequest.Header.Set("X-Codeium-Csrf-Token", csrfToken)

	response, err := client.Do(httpRequest)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
			return nil, &MetadataRequestError{
				Message: fmt.Sprintf("Antigravity metadata request timed out for %s", request.Source),
			}
		}
		return nil, &MetadataRequestError{
			Message: formatMetadataRequestTransportError(request.Source, err),
		}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, &MetadataRequestError{
			Message: formatMetadataRequestHTTPError(request.Source, response.StatusCode),
		}
	}
	// The ceiling is enforced while reading rather than after: a hostile or
	// broken response must not be materialised in full before it is rejected.
	limited := io.LimitReader(response.Body, maxMetadataResponseBytes+1)
	payload, err := io.ReadAll(limited)
	if err != nil {
		return nil, &MetadataRequestError{
			Message: formatMetadataRequestTransportError(request.Source, err),
		}
	}
	if len(payload) > maxMetadataResponseBytes {
		return nil, &MetadataRequestError{
			Message: fmt.Sprintf("Antigravity metadata response exceeded the %d-byte limit for %s",
				maxMetadataResponseBytes, request.Source),
		}
	}
	var decoded any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, &MetadataRequestError{
			Message: fmt.Sprintf("Antigravity metadata request returned invalid JSON for %s", request.Source),
		}
	}
	return decoded, nil
}

// MetadataRequestError reports a language-server request failure whose message
// the caller classifies as "unavailable" or "failed".
type MetadataRequestError struct{ Message string }

func (e *MetadataRequestError) Error() string { return e.Message }

func formatMetadataRequestHTTPError(source Source, statusCode int) string {
	return fmt.Sprintf("Antigravity metadata request failed for %s: HTTP %d", source, statusCode)
}

func formatMetadataRequestTransportError(source Source, err error) string {
	return fmt.Sprintf("Antigravity metadata request transport failed for %s: %v", source, err)
}

// closeLanguageServerGracePeriod is the TS closeLanguageServer's 2s window
// between SIGTERM and SIGKILL.
const closeLanguageServerGracePeriod = 2 * time.Second

func (p *languageServerProcess) close() error {
	if p.command.Process == nil {
		return nil
	}
	select {
	case <-p.exited:
		return nil
	default:
	}
	// The TS side sends SIGTERM, waits up to two seconds for the server to
	// exit, and only then escalates to SIGKILL. Windows has no SIGTERM for a
	// child process, so there the graceful step is skipped.
	if err := p.command.Process.Signal(syscall.SIGTERM); err != nil {
		return p.kill()
	}
	select {
	case <-p.exited:
		return nil
	case <-time.After(closeLanguageServerGracePeriod):
		return p.kill()
	}
}

func (p *languageServerProcess) kill() error {
	if err := p.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

// allocatePort asks the kernel for a free loopback port.
func allocatePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, errors.New("could not allocate a loopback port for the Antigravity language server")
	}
	return address.Port, nil
}

func randomHex(bytesCount int) (string, error) {
	buffer := make([]byte, bytesCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}
