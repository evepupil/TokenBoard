package antigravitygui

import (
	"os"
	"path/filepath"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
)

// Source names which GUI variant is collecting.
type Source = string

// Options configures one GUI/IDE collection. Zero values fall back to the
// environment and the clock.
type Options struct {
	// Source is "antigravity" or "antigravity-ide": it selects the cursor key
	// namespace and the default conversations directory.
	Source          Source
	Timezone        string
	CollectedAt     string
	Since           string
	StateDir        string
	CursorScope     string
	ConversationDir string
	SQLiteBin       *string
	ReadSQLite      antigravityhistory.ReadSQLite
	StatFile        antigravityhistory.StatFile
	ListFiles       antigravityhistory.ListFiles
	// ReadDbUsageEvents replaces the SQLite reader for tests and the shadow
	// harness.
	ReadDbUsageEvents func(antigravityhistory.Options) (antigravityhistory.Result, error)
	// RequestGeneratorMetadata, when set, enables the language-server route
	// and suppresses the SQLite read.
	RequestGeneratorMetadata func(request GeneratorMetadataRequest) (any, error)
	// ListCascades replaces the conversations directory walk for the
	// language-server route; ListCascadeIDs is its id-only form.
	ListCascades   func() ([]CascadeRef, error)
	ListCascadeIDs func() ([]string, error)
	// LanguageServerPath overrides the server executable; empty resolves
	// TOKENBOARD_ANTIGRAVITY_LANGUAGE_SERVER, then the macOS default.
	LanguageServerPath string
	// OverrideIdeVersion is passed to --override_ide_version.
	OverrideIdeVersion string
	// LanguageServerPort pins the server port; zero allocates one.
	LanguageServerPort int
	// MaxLanguageServerCascades bounds how many cascades one run may request.
	// Nil means "unset" (the default budget); a value is used as given, so an
	// explicit zero is the "ask nothing" the TS `0` is.
	MaxLanguageServerCascades *int
	// MaxDbFiles is the per-run database budget. Nil means "unset": a bounded
	// run keeps the reader's default and a full-history run reads everything.
	MaxDbFiles *int
	// Stderr receives diagnostics. Nil discards them.
	Stderr func(line string)
	// Env resolves TOKENBOARD_SINCE and friends; nil means the process env.
	Env func(string) string
	// HomeDir is the default conversations directory's root. Empty resolves
	// the process home.
	HomeDir string
}

// defaultConversationDir mirrors the TS default: ~/.gemini/<source>/conversations.
func defaultConversationDir(options Options) string {
	home := options.HomeDir
	if home == "" {
		resolved, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = resolved
	}
	return filepath.Join(home, ".gemini", string(options.Source), "conversations")
}

// nowISO is the wall-clock stamp the TS writer produces.
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
