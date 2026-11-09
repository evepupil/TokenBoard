module github.com/MisonL/TokenBoard/clients/go

go 1.27

// Pinned past CVE-2026-111943 (crypto/x509 blocked a set of compromised
// intermediate certificates). The `go` directive alone lets CI and local
// toolchains resolve any 1.27.x, so a machine still on 1.27.1 would silently
// build and test a client that trusts those chains. A toolchain line makes
// both ends fetch 1.27.3 before compiling.
toolchain go1.27.3

require (
	github.com/klauspost/compress v1.20.3
	github.com/pelletier/go-toml/v2 v2.4.3
	golang.org/x/crypto v0.58.0
	golang.org/x/net v0.62.0
	golang.org/x/sys v0.49.0
	modernc.org/sqlite v1.60.1
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/text v0.43.0 // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)
