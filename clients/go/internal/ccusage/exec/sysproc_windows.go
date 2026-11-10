//go:build windows

package exec

import "syscall"

// verbatimProcessAttr passes a fully pre-quoted command line to CreateProcess,
// the Go equivalent of Node's windowsVerbatimArguments: the cmd.exe wrapper
// receives exactly the bytes built in buildShellInvocation.
func verbatimProcessAttr(cmdLine string) *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CmdLine: cmdLine}
}
