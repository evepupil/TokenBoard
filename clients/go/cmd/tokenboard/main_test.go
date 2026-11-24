package main

// G1 for S5 (2026-11-10, spec §2 G1): once every source runs natively, the
// shipped binary has no reason to carry the code that acquired, spawned or
// spliced a ccusage subprocess. This test walks the real import graph of the
// package that builds the binary; reintroducing any of those layers anywhere
// below it fails here rather than shipping.

import (
	"bufio"
	"os/exec"
	"strings"
	"testing"
)

// retiredPackages are the acquisition and execution layers Task 8 removes.
// internal/ccusage itself stays: it is the shared report contract.
var retiredPackages = []string{
	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage/acquire",
	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage/exec",
	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage/runner",
}

func TestTokenboardBinaryCarriesNoCcusageAcquisition(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("go list -deps .: %v", err)
	}
	deps := map[string]bool{}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		deps[strings.TrimSpace(scanner.Text())] = true
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !deps["github.com/MisonL/TokenBoard/clients/go/internal/cli"] {
		t.Fatal("the dependency list does not include internal/cli; go list answered for the wrong package")
	}
	for _, retired := range retiredPackages {
		if deps[retired] {
			t.Errorf("the tokenboard binary depends on %s; the native sources must not reach the ccusage "+
				"acquisition or execution layers", retired)
		}
	}
}
