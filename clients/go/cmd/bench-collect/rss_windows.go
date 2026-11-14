//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// Windows has no wait4 rusage, and Go does not expose the handle os.Process
// keeps, so the child's footprint has to be read through a second handle the
// benchmark opens itself. Both halves of this file report the metric as
// unavailable when the calls fail: a benchmark that invents a memory number is
// worse than one that says it could not measure it.
const (
	processQueryInformation = 0x0400
	processVMRead           = 0x0010
)

// childObserver is the child handle opened while the process is alive.
type childObserver struct {
	handle syscall.Handle
	valid  bool
}

// observeChild opens a handle to the freshly started child. It must happen
// before the child exits: OpenProcess on a pid that is already gone fails, and
// without a handle the process object (and its counters) can be reclaimed.
func observeChild(process *os.Process) childObserver {
	if process == nil {
		return childObserver{}
	}
	handle, err := syscall.OpenProcess(
		processQueryInformation|processVMRead, false, uint32(process.Pid))
	if err != nil {
		return childObserver{}
	}
	return childObserver{handle: handle, valid: true}
}

// peakRSS reads PeakWorkingSetSize — the Windows equivalent of peak resident
// memory — from the handle opened by observeChild.
func (o childObserver) peakRSS(*os.ProcessState) (uint64, string) {
	if !o.valid {
		return 0, rssSourceUnavailable
	}
	defer syscall.CloseHandle(o.handle)
	counters, err := processMemoryInfo(o.handle)
	if err != nil || counters.PeakWorkingSetSize == 0 {
		return 0, rssSourceUnavailable
	}
	return uint64(counters.PeakWorkingSetSize), rssSourceWindows
}

// selfPeakRSS is the native side's measurement on Windows: the provider runs
// in-process, so the current process's counter is the right one.
func selfPeakRSS() (uint64, string) {
	handle, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, rssSourceUnavailable
	}
	counters, err := processMemoryInfo(handle)
	if err != nil || counters.PeakWorkingSetSize == 0 {
		return 0, rssSourceUnavailable
	}
	return uint64(counters.PeakWorkingSetSize), rssSourceWindows
}

// processMemoryCounters is PROCESS_MEMORY_COUNTERS. Size is the struct's byte
// length, which GetProcessMemoryInfo requires; SIZE_T fields are uintptr so the
// layout is right on both 386 and amd64.
type processMemoryCounters struct {
	Size                       uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetProcessMemoryInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
)

// processMemoryInfo calls K32GetProcessMemoryInfo, which kernel32 exports on
// Windows 7 and later.
func processMemoryInfo(handle syscall.Handle) (processMemoryCounters, error) {
	counters := processMemoryCounters{Size: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	result, _, callErr := procGetProcessMemoryInfo.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.Size),
	)
	if result == 0 {
		if callErr != syscall.Errno(0) {
			return processMemoryCounters{}, callErr
		}
		return processMemoryCounters{}, syscall.EINVAL
	}
	return counters, nil
}
