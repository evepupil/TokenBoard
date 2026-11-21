package tools

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// readChunkBytes bounds how much of one file is read between budget checks. A
// whole-file os.ReadFile cannot be interrupted: a single large transcript would
// run to completion past the invocation's deadline and only then report a
// timeout, spending the very time the budget exists to bound. Reading in chunks
// checks the budget every readChunkBytes, so a runaway read stops within one
// chunk.
const readChunkBytes = 64 * 1024

// ReadFileWithinBudget is os.ReadFile with the caller's budget consulted
// between chunks. On cancellation it returns the context's error, not partial
// content: a truncated read would parse as a smaller file and look like real
// usage instead of a stopped one. Exported for the adapters outside this
// package (copilot) that read whole files too.
func ReadFileWithinBudget(o Options, path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	var content []byte
	buffer := make([]byte, readChunkBytes)
	for {
		if err := o.ContextErr(); err != nil {
			return nil, err
		}
		read, readErr := file.Read(buffer)
		if read > 0 {
			content = append(content, buffer[:read]...)
		}
		if readErr == io.EOF {
			return content, nil
		}
		if readErr != nil {
			return nil, readErr
		}
	}
}

// readToolFile reads one file an adapter already discovered. A file that no
// longer exists is skipped quietly — discovery ran a moment ago, so that is the
// temp-file race the other adapters treat as normal — while a real read failure
// (a permission problem, a device error) is recorded through readErrorf so the
// provider can report it. Returning no content in both cases keeps each
// adapter's skip loop unchanged.
//
// A budget that ends mid-read also returns no content, but records nothing: a
// stopped read is not a broken file, and the adapter's next loop-top ContextErr
// check aborts the load with the budget error itself.
//
// The line names the file's base name only: it reaches the run's stderr log,
// which operators paste into issues, and the directory layout is not the
// reader's business. There is no debug line carrying the full path: the caller
// forwards Debug straight to that same stderr in production, so it would put
// the path back and repeat the report twice.
func readToolFile(path, label string, o Options) ([]byte, bool) {
	content, err := ReadFileWithinBudget(o, path)
	if err != nil {
		if o.ContextErr() != nil {
			return nil, false
		}
		if errors.Is(err, fs.ErrNotExist) {
			o.debugf(fmt.Sprintf("Failed to read %s %s: %v", label, filepath.Base(path), fs.ErrNotExist))
			return nil, false
		}
		// The underlying cause is the errno ("permission denied"), not the
		// *fs.PathError that spells the full path out again.
		var pathErr *fs.PathError
		cause := err
		if errors.As(err, &pathErr) {
			cause = pathErr.Err
		}
		o.readErrorf(path, fmt.Sprintf("Failed to read %s %s: %v", label, filepath.Base(path), cause))
		return nil, false
	}
	return content, true
}

// recordDatabaseReadError is the SQLite counterpart of readToolFile: a vanished
// database stays a debug line, a real open or query failure is recorded for the
// provider to report, and neither line carries the directory (Debug is the same
// stderr in production).
//
// In practice the driver reports a missing or unreadable database from Query as
// "unable to open database file (14)" — text, not a *fs.PathError — so a
// vanished database discovered late lands on the report side: one extra
// warning, no data lost. The quiet path covers an open that fails outright.
//
// A budget that ended mid-query is quiet for the same reason a stopped file
// read is: the driver interrupts the statement and hands back context.Canceled,
// which is not the database being broken, and the adapter's next loop-top check
// aborts the load with the budget error itself.
func recordDatabaseReadError(o Options, line, path string, err error) {
	if o.ContextErr() != nil {
		return
	}
	var pathErr *fs.PathError
	cause := err
	if errors.As(err, &pathErr) {
		cause = pathErr.Err
	}
	if errors.Is(cause, fs.ErrNotExist) {
		o.debugf(line + " " + filepath.Base(path) + ": " + cause.Error())
		return
	}
	o.readErrorf(path, line+" "+filepath.Base(path)+": "+cause.Error())
}
