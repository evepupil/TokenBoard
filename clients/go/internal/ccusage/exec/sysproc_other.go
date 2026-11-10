//go:build !windows

package exec

import "syscall"

// verbatimProcessAttr is only meaningful on Windows; elsewhere the shell
// wrapper path is never taken and this returns nil.
func verbatimProcessAttr(string) *syscall.SysProcAttr {
	return nil
}
