package ccusagetool

// The copilot adapter registers itself from its init (adapters/copilot/register.go),
// so it has to be imported from a NON-TEST file: native.go carries that import.
// A _test.go import keeps the package's own tests green while every production
// build loses the registration, which is why the import lives beside the runner
// and TestCopilotAdapterIsImportedFromAProductionFile guards it.
