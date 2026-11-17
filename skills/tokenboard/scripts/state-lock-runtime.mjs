import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { currentProcessStartIdentity } from './process-liveness.mjs'

// stateLockRuntime builds the environment coordinator-lock.mjs operates on.
//
// The lock file protocol is a cross-language contract: Go's
// `internal/state.Acquire` reads and writes the same JSON record in the same
// file, so a Go `self-update` and a skill install can exclude each other by
// taking the same path. Both sides must therefore keep the default timeout
// and the file name in sync; `selfUpdateLockPath` is the one name they share.
export function stateLockRuntime({ lockTimeoutMs }) {
  let processStartIdentity
  return {
    // A caller that does not wait sets its own budget: the lock is taken with
    // this deadline before `waitForLock` gives up and reports a timeout.
    lockTimeoutMs,
    chmod: (path, mode) => chmodSync(path, mode),
    lstat: (path) => lstatSync(path),
    mkdir: (path, options) => mkdirSync(path, options),
    now: Date.now,
    process,
    getProcessStartIdentity: () => {
      if (processStartIdentity) return processStartIdentity
      processStartIdentity = currentProcessStartIdentity()
      return processStartIdentity
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    rename: renameSync,
    link: linkSync,
    sleep: sleepSync,
    unlink: unlinkSync,
    writeFile: writeFileSync
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

// selfUpdateLockFileName is the file Go's `self-update` takes in the state
// directory before it touches the executable. An installer that stages the
// same `<binary>.new` must take it too.
export const selfUpdateLockFileName = 'self-update.lock'
