package state

import "testing"

// The CSV tasklist prints is `"Image","PID","Session","#","Mem"`. The original substring
// check also matched the Session# column, so `tasklist /FI "PID eq 1"` reported a process in
// session 1 as the entry asked about. Only the PID field counts.
func TestTasklistContainsPidReadsThePidFieldOnly(t *testing.T) {
	rows := []struct {
		name   string
		output string
		pid    int
		want   bool
	}{
		{name: "the pid itself", output: "\"node.exe\",\"1234\",\"Console\",\"1\",\"10,000 K\"\r\n", pid: 1234, want: true},
		{name: "a session number that equals the pid", output: "\"node.exe\",\"1234\",\"Console\",\"1\",\"10,000 K\"\r\n", pid: 1, want: false},
		{name: "a pid that appears in the memory column", output: "\"node.exe\",\"1234\",\"Console\",\"1\",\"7,7 K\"\r\n", pid: 7, want: false},
		{name: "the localized no-match notice", output: "信息: 没有运行的任务匹配指定的标准。\r\n", pid: 1234, want: false},
		{name: "blank output", output: "", pid: 1234, want: false},
		{name: "second row matches", output: "\"a.exe\",\"4\",\"Services\",\"0\",\"1 K\"\r\n\"b.exe\",\"999\",\"Console\",\"1\",\"2 K\"\r\n", pid: 999, want: true},
		{name: "image name with a quoted comma", output: "\"we,ird.exe\",\"777\",\"Console\",\"1\",\"3 K\"\r\n", pid: 777, want: true},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			if got := tasklistContainsPid(row.output, row.pid); got != row.want {
				t.Errorf("tasklistContainsPid(%q, %d) = %v, want %v", row.output, row.pid, got, row.want)
			}
		})
	}
}
