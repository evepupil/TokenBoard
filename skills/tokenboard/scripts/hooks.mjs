import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertAntigravitySettingsValid,
  getAntigravityHookStatus,
  installAntigravityHook,
  uninstallAntigravityHook
} from './antigravity-hook.mjs'
import {
  assertClaudeSettingsValid,
  getClaudeHookStatus,
  installClaudeHook,
  uninstallClaudeHook
} from './claude-hook.mjs'
import { configDir, parseArgs } from './config.mjs'
import { assertCodexNotifyWritable, getCodexHookStatus, installCodexHook, uninstallCodexHook } from './codex-hook.mjs'
import { errorMessage } from './error-message.mjs'
import {
  antigravitySource,
  claudeSource,
  codexSource,
  isTokenBoardNotifyHandler,
  nodeFs,
  notifyHandlerMarker,
  readOptional,
  readSources,
  readUninstallSources,
  removeNotifyHandler
} from './hooks-utils.mjs'

export const notifyHandlerErrorLogMaxBytes = 64 * 1024
export const notifyHandlerErrorMessageMaxChars = 4 * 1024
export const dispatchWorkerIdentityProbeGraceMs = 30 * 1000
export const processIdentityCacheTtlMs = 1000
export const trailingWorkerIdentityProbeGraceMs = 30 * 1000

export function hookPaths({ homeDir = homedir(), stateDir = configDir(), env = process.env } = {}) {
  const tokenboardHome = stateDir
  const binDir = join(tokenboardHome, 'bin')
  const codexHome = resolveEnvPath(env.CODEX_HOME) || join(homeDir, '.codex')
  const claudeHome =
    resolveEnvPath(env.CLAUDE_CONFIG_DIR) || resolveEnvPath(env.CLAUDE_HOME) || join(homeDir, '.claude')
  const antigravityHome =
    resolveEnvPath(env.ANTIGRAVITY_CONFIG_DIR) ||
    resolveEnvPath(env.ANTIGRAVITY_HOME) ||
    join(homeDir, '.gemini', 'antigravity-cli')
  const antigravityIdeHome =
    resolveEnvPath(env.ANTIGRAVITY_IDE_CONFIG_DIR) || join(homeDir, '.gemini', 'antigravity-ide')
  const antigravityAppHome = resolveEnvPath(env.ANTIGRAVITY_APP_CONFIG_DIR) || join(homeDir, '.gemini', 'antigravity')
  return {
    stateDir: tokenboardHome,
    binDir,
    notifyPath: join(binDir, 'notify.cjs'),
    notifyScriptPath: fileURLToPath(new URL('./notify.mjs', import.meta.url)),
    statuslineScriptPath: fileURLToPath(new URL('./antigravity-statusline.mjs', import.meta.url)),
    codexConfigPath: join(codexHome, 'config.toml'),
    codexOriginalPath: join(tokenboardHome, 'codex_notify_original.json'),
    claudeSettingsPath: join(claudeHome, 'settings.json'),
    antigravitySettingsPath: join(antigravityHome, 'settings.json'),
    antigravityIdePath: antigravityIdeHome,
    antigravityPath: antigravityAppHome,
    antigravityOriginalStatuslinePath: join(tokenboardHome, 'antigravity_statusline_original.json')
  }
}

export function installHooks(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  const sources = readSources(flags.source || flags.sources || 'all')
  validateHookTargets({ sources, paths, fs })

  if (needsNotifyHandler(sources)) {
    fs.mkdir(paths.binDir, { recursive: true, mode: 0o700 })
    fs.writeFile(
      paths.notifyPath,
      buildNotifyHandler({
        stateDir: paths.stateDir,
        notifyScriptPath: paths.notifyScriptPath,
        nodePath
      }),
      { mode: 0o700 }
    )
  }

  const results = []
  if (sources.includes(codexSource)) {
    results.push(installCodexHook({ paths, fs, nodePath, platform }))
  }
  if (sources.includes(claudeSource)) {
    results.push(installClaudeHook({ paths, fs, nodePath, platform }))
  }
  if (sources.includes(antigravitySource)) {
    results.push(installAntigravityHook({ paths, fs, nodePath, platform }))
  }
  const installedHooks = {
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform }),
    antigravityCli: getAntigravityHookStatus({ paths, fs })
  }
  if (canRemoveNotifyHandler(installedHooks)) {
    removeNotifyHandler({ paths, fs })
  }
  return { notifyPath: paths.notifyPath, hooks: results }
}

export function refreshInstalledNotifyHandler(options = {}) {
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  const status = {
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform })
  }

  const unreadable = Object.entries(status)
    .filter(([, value]) => value === 'error')
    .map(([source]) => source)
  if (unreadable.length > 0) {
    throw new Error(
      `Unable to refresh TokenBoard notify handler while hook configuration is unreadable: ${unreadable.join(', ')}`
    )
  }

  const sources = []
  if (status.codex === 'installed') sources.push(codexSource)
  if (status.claudeCode === 'installed') sources.push(claudeSource)
  if (sources.length === 0) {
    return { notifyPath: paths.notifyPath, changed: false, sources }
  }

  fs.mkdir(paths.binDir, { recursive: true, mode: 0o700 })
  fs.writeFile(
    paths.notifyPath,
    buildNotifyHandler({
      stateDir: paths.stateDir,
      notifyScriptPath: paths.notifyScriptPath,
      nodePath
    }),
    { mode: 0o700 }
  )
  return { notifyPath: paths.notifyPath, changed: true, sources }
}

export function uninstallHooks(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  const sourceValue = flags.source || flags.sources || 'all'
  const sources = readUninstallSources(sourceValue)
  const explicitAntigravity = sourceWasExplicitlyRequested(sourceValue, antigravitySource)
  validateUninstallHookTargets({ sources, explicitAntigravity, paths, fs })
  const results = []

  if (sources.includes(codexSource)) {
    results.push(uninstallCodexHook({ paths, fs }))
  }
  if (sources.includes(claudeSource)) {
    results.push(uninstallClaudeHook({ paths, fs, nodePath, platform }))
  }
  if (sources.includes(antigravitySource)) {
    try {
      if (!explicitAntigravity) {
        assertAntigravitySettingsValid({ paths, fs })
      }
    } catch (error) {
      results.push({
        source: antigravitySource,
        action: 'skip',
        changed: false,
        incomplete: true,
        detail: `Antigravity statusline not checked: ${errorMessage(error)}`
      })
      return finishUninstallHooks({ results, paths, fs, nodePath, platform })
    }
    try {
      results.push(uninstallAntigravityHook({ paths, fs }))
    } catch (error) {
      finishUninstallHooksBeforeRethrow({ results, paths, fs, nodePath, platform }, error)
      throw error
    }
  }

  return finishUninstallHooks({ results, paths, fs, nodePath, platform })
}

function finishUninstallHooks({ results, paths, fs, nodePath, platform }) {
  const remainingHooks = {
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform }),
    antigravityCli: getAntigravityHookStatus({ paths, fs })
  }
  const notifyRemoved = canRemoveNotifyHandler(remainingHooks) ? removeNotifyHandler({ paths, fs }) : false
  return { notifyPath: paths.notifyPath, notifyRemoved, hooks: results }
}

function finishUninstallHooksBeforeRethrow(args, originalError) {
  try {
    finishUninstallHooks(args)
  } catch (cleanupError) {
    attachCleanupError(originalError, cleanupError)
  }
}

function attachCleanupError(originalError, cleanupError) {
  if (originalError && typeof originalError === 'object') {
    originalError.cleanupError = cleanupError
  }
}

export function hookStatus(options = {}) {
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  return {
    notifyPath: paths.notifyPath,
    notifyHandler: isTokenBoardNotifyHandler(readOptional(paths.notifyPath, fs)) ? 'installed' : 'not-installed',
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform }),
    antigravityCli: getAntigravityHookStatus({ paths, fs }),
    antigravityIde: getAntigravityGuiStatus(paths.antigravityIdePath, fs),
    antigravity: getAntigravityGuiStatus(paths.antigravityPath, fs)
  }
}

export function buildNotifyHandler({ stateDir, notifyScriptPath, nodePath }) {
  return [
    notifyHandlerHeader({ stateDir, notifyScriptPath, nodePath }),
    notifyHandlerArgParser(),
    notifyHandlerMainFlow(),
    notifyHandlerOriginalForwarder(),
    notifyHandlerHelpers()
  ].join('\n')
}

function notifyHandlerHeader({ stateDir, notifyScriptPath, nodePath }) {
  return `#!/usr/bin/env node
// ${notifyHandlerMarker} - Auto-generated by TokenBoard. Do not edit.
"use strict";

const { appendFileSync, closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } = require("node:fs");
const { join, resolve, win32: windowsPath } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { homedir } = require("node:os");

const STATE_DIR = ${JSON.stringify(stateDir)};
const SIGNAL_DIR = join(STATE_DIR, "notify.signal.d");
const DISPATCH_LOCK_PATH = join(STATE_DIR, "notify.dispatch.lock");
const DISPATCH_WORKER_PATH = join(STATE_DIR, "notify.dispatch.worker");
const DISPATCH_LOCK_STARTUP_GRACE_MS = 5000;
const DISPATCH_WORKER_IDENTITY_PROBE_GRACE_MS = ${dispatchWorkerIdentityProbeGraceMs};
const TRAILING_WORKER_IDENTITY_PROBE_GRACE_MS = ${trailingWorkerIdentityProbeGraceMs};
const TASKLIST_TIMEOUT_MS = 2000;
const PROCESS_IDENTITY_TIMEOUT_MS = 2000;
const DARWIN_PROCESS_INFO_SIZE = 136;
const DARWIN_START_SECONDS_OFFSET = 120;
const DARWIN_START_MICROSECONDS_OFFSET = 128;
const SYSTEM_ROOT = /^[A-Za-z]:[\\\\/]/.test(typeof process.env.SystemRoot === "string" ? process.env.SystemRoot.trim() : "")
  ? process.env.SystemRoot.trim()
  : "C:\\\\Windows";
const TASKLIST_COMMAND = windowsPath.join(
  SYSTEM_ROOT,
  "System32",
  "tasklist.exe"
);
const NODE_PATH = process.platform === "win32"
  ? ${JSON.stringify(nodePath || process.execPath)}
  : process.execPath;
const NOTIFY_SCRIPT = ${JSON.stringify(notifyScriptPath)};
const SELF_PATH = resolve(__filename);
const HOME_DIR = homedir();
const HANDLER_ERROR_LOG_PATH = join(STATE_DIR, "notify-handler-errors.log");
const HANDLER_ERROR_LOG_MAX_BYTES = ${notifyHandlerErrorLogMaxBytes};
const HANDLER_ERROR_MESSAGE_MAX_CHARS = ${notifyHandlerErrorMessageMaxChars};
const PROCESS_IDENTITY_CACHE_PATH = join(STATE_DIR, "notify-process-identity-cache.json");
const PROCESS_IDENTITY_CACHE_TTL_MS = ${processIdentityCacheTtlMs};
const PROCESS_START_IDENTITY_CACHE = new Map();
`
}

function notifyHandlerArgParser() {
  return `
const rawArgs = process.argv.slice(2);
let source = "";
const payloadArgs = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (!source && arg === "--source") {
    source = rawArgs[index + 1] || source;
    index += 1;
    continue;
  }
  if (!source && arg.startsWith("--source=")) {
    source = arg.slice("--source=".length) || source;
    continue;
  }
  payloadArgs.push(arg);
}

if (source !== "codex" && source !== "claude-code") {
  recordHandlerError("source", new Error("Unsupported TokenBoard hook source"));
  process.exit(0);
}
`
}

function notifyHandlerMainFlow() {
  return `
try {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const signalPayload = JSON.stringify({
    source,
    requestedAt: new Date().toISOString(),
  }) + "\\n";
  let queueError;
  try {
    writeQueuedSignal(signalPayload, source);
  } catch (error) {
    queueError = error;
  }
  if (queueError) {
    appendFileSync(join(STATE_DIR, "notify.signal"), signalPayload, "utf8");
    throw queueError;
  }
} catch (error) {
  recordHandlerError("enqueue", error);
}

const dispatchToken = hasLiveTrailingWorker() ? "" : acquireDispatchLock();
if (dispatchToken) {
  let dispatchReleased = false;
  const releaseDispatch = () => {
    if (dispatchReleased) return;
    dispatchReleased = true;
    try {
      releaseDispatchLock(dispatchToken);
    } catch (error) {
      recordHandlerError("dispatch-lock", error);
    }
  };
  try {
    const child = spawn(NODE_PATH, [NOTIFY_SCRIPT, "--source", source], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: STATE_DIR,
        TOKENBOARD_STATE_DIR: STATE_DIR,
        TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH: DISPATCH_LOCK_PATH,
        TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN: dispatchToken,
        TOKENBOARD_NOTIFY_DISPATCH_WORKER_PATH: dispatchWorkerPath(dispatchToken),
      },
    });
    const detachChild = () => {
      try {
        child.unref();
      } catch (error) {
        recordHandlerError("background", error, [NODE_PATH, NOTIFY_SCRIPT]);
      }
    };
    if (typeof child.once === "function") {
      child.once("spawn", detachChild);
      child.once("error", (error) => {
        recordHandlerError("background", error, [NODE_PATH, NOTIFY_SCRIPT]);
        releaseDispatch();
        detachChild();
      });
    }
    if (typeof child.pid === "number") {
      setDispatchWorkerPid(dispatchToken, child.pid);
      if (typeof child.once !== "function") detachChild();
    } else {
      releaseDispatch();
    }
  } catch (error) {
    releaseDispatch();
    recordHandlerError("background", error, [NODE_PATH, NOTIFY_SCRIPT]);
  }
}
`
}

function notifyHandlerOriginalForwarder() {
  return `
if (source === "codex") {
  let originalCommandPath = "";
  try {
    const original = JSON.parse(readFileSync(join(STATE_DIR, "codex_notify_original.json"), "utf8"));
    const cmd = Array.isArray(original && original.notify) ? original.notify : null;
    if (cmd && cmd.length > 0 && !isSelfNotify(cmd)) {
      originalCommandPath = typeof cmd[0] === "string" ? cmd[0] : "";
      const child = spawnOriginalNotify(cmd[0], [...cmd.slice(1), ...payloadArgs]);
      if (typeof child.once === "function") {
        const detachOriginal = () => {
          try {
            child.unref();
          } catch (error) {
            recordHandlerError("original", error, [originalCommandPath]);
          }
        };
        child.once("spawn", detachOriginal);
        child.once("error", (error) => {
          recordHandlerError("original", error, [originalCommandPath]);
          detachOriginal();
        });
      } else {
        child.unref();
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("original", error, [originalCommandPath]);
  }
}

`
}

function notifyHandlerHelpers() {
  return `
function spawnOriginalNotify(command, args) {
  const options = {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  };
  if (process.platform !== "win32" || !/\\.(cmd|bat)$/i.test(command)) {
    return spawn(command, args, options);
  }

  assertWindowsOriginalNotifyArgs([command, ...args]);
  const commandLine = [command, ...args].map(quoteWindowsOriginalNotifyArg).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", [
    "/d",
    "/s",
    "/c",
    commandLine.startsWith('"') ? '"' + commandLine + '"' : commandLine,
  ], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function assertWindowsOriginalNotifyArgs(args) {
  const unsafe = /[&|<>^%!"\\r\\n]/;
  const index = args.findIndex((arg) => typeof arg !== "string" || unsafe.test(arg));
  if (index >= 0) {
    throw new Error("Refusing unsafe Windows original notify argument " + index);
  }
}

function quoteWindowsOriginalNotifyArg(value) {
  const text = String(value);
  const needsQuotes = text.length === 0 || /[\\s()]/.test(text) || /\\\\$/.test(text);
  if (!needsQuotes) return text;
  const trailingBackslashes = text.match(/\\\\+$/)?.[0].length || 0;
  return '"' + text + "\\\\".repeat(trailingBackslashes) + '"';
}

function acquireDispatchLock() {
  const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  try {
    writeFileSync(DISPATCH_LOCK_PATH, JSON.stringify({
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (!error || error.code !== "EEXIST") {
      recordHandlerError("dispatch-lock", error);
      return "";
    }
    let current;
    try {
      current = readDispatchFile(DISPATCH_LOCK_PATH);
    } catch (error) {
      // A structurally damaged dispatch lock must not prevent the original
      // provider notification from running. Keep the damage visible locally.
      recordHandlerError("dispatch-lock", error);
      return "";
    }
    if (isDispatchLockOwnerAlive(current)) return "";
    if (!removeStaleDispatchLock()) return "";
    try {
      writeFileSync(DISPATCH_LOCK_PATH, JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return token;
    } catch (retryError) {
      if (retryError && retryError.code !== "EEXIST") recordHandlerError("dispatch-lock", retryError);
      return "";
    }
  }
}

function hasLiveTrailingWorker() {
  try {
    const trailing = JSON.parse(readFileSync(join(STATE_DIR, "trailing.lock"), "utf8"));
    const pid = Number(trailing && trailing.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    const recordedIdentity = trailing && typeof trailing.processStartIdentity === "string"
      ? trailing.processStartIdentity
      : "";
    // Legacy pid-only records cannot distinguish a reused pid from the
    // original trailing worker. Only suppress dispatch after the recorded
    // process start identity has been verified.
    if (!recordedIdentity) {
      // New trailing workers publish this marker while the platform identity
      // probe is still in progress. Keep their lock only for the bounded
      // probe window; legacy pid-only records remain fail-open to avoid
      // trusting an unverifiable PID indefinitely.
      const probeStartedAt = Date.parse(trailing && trailing.identityProbeStartedAt);
      const elapsedMs = Date.now() - probeStartedAt;
      if (!Number.isFinite(probeStartedAt) || elapsedMs < 0 || elapsedMs >= TRAILING_WORKER_IDENTITY_PROBE_GRACE_MS) {
        return false;
      }
      return isProcessAlive(pid);
    }
    if (!isProcessAlive(pid)) return false;
    const currentIdentity = probeProcessStartIdentity(pid, recordedIdentity);
    if (currentIdentity.status === "dead") return false;
    if (currentIdentity.status === "known") return currentIdentity.value === recordedIdentity;
    // An indeterminate identity probe must not turn a live process into a
    // stale lock. Keep the lock until the process is proven dead or its start
    // identity is proven different.
    return true;
  } catch (_) {
    return false;
  }
}

function setDispatchWorkerPid(token, pid) {
  try {
    const current = JSON.parse(readFileSync(DISPATCH_LOCK_PATH, "utf8"));
    if (!current || current.token !== token) return;
    const workerPath = dispatchWorkerPath(token);
    const workerStartedAt = new Date().toISOString();
    const worker = {
      token,
      pid,
      startedAt: workerStartedAt,
      identityProbeStartedAt: workerStartedAt,
    };
    try {
      // The detached worker owns the reliable process-identity probe. Keep a
      // foreground marker only when it wins publication; never overwrite a
      // marker that the worker has already upgraded with its identity.
      writeFileSync(workerPath, JSON.stringify(worker), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    const verified = JSON.parse(readFileSync(DISPATCH_LOCK_PATH, "utf8"));
    if (!verified || verified.token !== token) removeDispatchWorker(token);
  } catch (error) {
    if (isMissingFileError(error)) {
      removeDispatchWorker(token);
      return;
    }
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
  }
}

function releaseDispatchLock(token) {
  if (!token) return;
  try {
    releaseOwnedDispatchFile(DISPATCH_LOCK_PATH, token);
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
  }
  removeDispatchWorker(token);
}

function removeStaleDispatchLock() {
  const quarantinePath = dispatchQuarantinePath(DISPATCH_LOCK_PATH);
  try {
    renameSync(DISPATCH_LOCK_PATH, quarantinePath);
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
    return false;
  }
  let current;
  try {
    current = readDispatchFile(quarantinePath);
  } catch (error) {
    try {
      restoreDispatchFile(DISPATCH_LOCK_PATH, quarantinePath);
    } catch (restoreError) {
      recordHandlerError("dispatch-lock", restoreError);
    }
    recordHandlerError("dispatch-lock", error);
    return false;
  }
  if (isDispatchLockOwnerAlive(current)) {
    try {
      restoreDispatchFile(DISPATCH_LOCK_PATH, quarantinePath);
    } catch (restoreError) {
      // A stale-lock recovery failure must not prevent the provider's
      // original notification from being forwarded.
      recordHandlerError("dispatch-lock", restoreError);
    }
    return false;
  }
  try {
    unlinkSync(quarantinePath);
    removeDispatchWorker(current && current.token);
    return true;
  } catch (error) {
    try {
      restoreDispatchFile(DISPATCH_LOCK_PATH, quarantinePath);
    } catch (restoreError) {
      recordHandlerError("dispatch-lock", restoreError);
    }
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
    return false;
  }
}

function releaseOwnedDispatchFile(path, token) {
  const quarantinePath = dispatchQuarantinePath(path);
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  let current;
  try {
    current = readDispatchFile(quarantinePath);
  } catch (error) {
    restoreDispatchFile(path, quarantinePath);
    throw error;
  }
  if (!current || current.token !== token) {
    restoreDispatchFile(path, quarantinePath);
    return false;
  }
  try {
    unlinkSync(quarantinePath);
    return true;
  } catch (error) {
    restoreDispatchFile(path, quarantinePath);
    throw error;
  }
}

function restoreDispatchFile(path, quarantinePath) {
  try {
    linkSync(quarantinePath, path);
  } catch (error) {
    if (!error || (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
  }
  try {
    unlinkSync(quarantinePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function dispatchQuarantinePath(path) {
  return path + ".release-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function isDispatchLockOwnerAlive(current) {
  if (!current) return false;
  const worker = readDispatchWorker(current.token);
  if (worker && worker.token === current.token) {
    const workerPid = Number(worker.pid);
    if (!Number.isSafeInteger(workerPid) || workerPid <= 0) return false;
    // The foreground marker's startup grace covers the short interval where
    // the detached worker has been spawned but has not completed its marker
    // publication yet. Avoid a platform process-identity probe in that
    // interval; on macOS the bounded probe can outlive a short-lived worker.
    if (isDispatchLockStarting(current)) {
      return true;
    }
    if (!isProcessAlive(workerPid)) return false;
    // After startup grace, a worker marker without a verified start identity
    // cannot distinguish the worker from a reused pid. Fail closed so the
    // queued signal can be dispatched instead of being suppressed indefinitely.
    // The worker publishes an explicit probe-start marker before the platform
    // identity lookup. Keep the lock during that bounded probe window so a
    // slow PowerShell/osascript startup does not create a duplicate worker.
    if (typeof worker.processStartIdentity !== "string" || !worker.processStartIdentity) {
      if (isDispatchWorkerIdentityProbeStarting(worker)) return true;
      return false;
    }
    const currentIdentity = probeProcessStartIdentity(workerPid, worker.processStartIdentity);
    if (currentIdentity.status === "dead") return false;
    if (currentIdentity.status === "known") return currentIdentity.value === worker.processStartIdentity;
    // Keep a live worker on an indeterminate identity result. Reclaiming here
    // could start a duplicate worker while the original still owns the lock.
    return true;
  }
  if (isDispatchLockStarting(current)) return true;
  // A markerless lock only proves that the foreground hook started. After
  // startup grace, trusting its pid would let a reused pid suppress dispatch
  // indefinitely. Reclaim it and let the next hook publish a worker marker.
  return false;
}

function readDispatchFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readDispatchWorker(token) {
  const tokenWorker = readDispatchFile(dispatchWorkerPath(token));
  if (tokenWorker && tokenWorker.token === token) return tokenWorker;
  const legacyWorker = readDispatchFile(DISPATCH_WORKER_PATH);
  return legacyWorker && legacyWorker.token === token ? legacyWorker : null;
}

function removeDispatchWorker(token) {
  if (!token) return;
  try {
    releaseOwnedDispatchFile(dispatchWorkerPath(token), token);
    releaseOwnedDispatchFile(DISPATCH_WORKER_PATH, token);
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
  }
}

function dispatchWorkerPath(token) {
  return DISPATCH_WORKER_PATH + "." + token;
}

function isDispatchLockStarting(current) {
  const startedAt = Date.parse(current && current.startedAt);
  const elapsedMs = Date.now() - startedAt;
  return Number.isFinite(startedAt) && elapsedMs >= 0 && elapsedMs < DISPATCH_LOCK_STARTUP_GRACE_MS;
}

function isDispatchWorkerIdentityProbeStarting(worker) {
  const startedAt = Date.parse(worker && worker.identityProbeStartedAt);
  const elapsedMs = Date.now() - startedAt;
  return Number.isFinite(startedAt) && elapsedMs >= 0 && elapsedMs < DISPATCH_WORKER_IDENTITY_PROBE_GRACE_MS;
}

function probeProcessStartIdentity(pid, expectedIdentity = "") {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "dead" };
  // Only cache the handler's own identity. Other pids can be reused while
  // this handler is invoked again, so their start probes use a short-lived
  // persistent cache keyed by both pid and the recorded identity.
  const shouldCache = pid === process.pid;
  const cacheKey = String(pid) + "\u0000" + expectedIdentity;
  const cached = shouldCache ? PROCESS_START_IDENTITY_CACHE.get(cacheKey) : undefined;
  if (cached) return cached;
  const diskCached = readCachedProcessStartIdentity(pid, expectedIdentity);
  if (diskCached) return diskCached;
  let result;
  if (process.platform === "linux") result = readLinuxProcessStartIdentity(pid);
  else if (process.platform === "darwin") result = readDarwinProcessStartIdentity(pid);
  else if (process.platform === "win32") result = readWindowsProcessStartIdentity(pid);
  else result = { status: "unknown" };
  if (shouldCache) PROCESS_START_IDENTITY_CACHE.set(cacheKey, result);
  if (result.status === "known") writeCachedProcessStartIdentity(pid, result.value);
  return result;
}

function readCachedProcessStartIdentity(pid, expectedIdentity) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(PROCESS_IDENTITY_CACHE_PATH, "utf8"));
  } catch (_) {
    return null;
  }
  const entry = cache && typeof cache === "object" ? cache[String(pid)] : null;
  if (!entry || typeof entry !== "object" || typeof entry.value !== "string" || !entry.value) return null;
  const checkedAt = Number(entry.checkedAt);
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt < 0 || Date.now() - checkedAt >= PROCESS_IDENTITY_CACHE_TTL_MS) {
    return null;
  }
  if (expectedIdentity && entry.value !== expectedIdentity) return null;
  return { status: "known", value: entry.value };
}

function writeCachedProcessStartIdentity(pid, value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    let cache = {};
    try {
      const parsed = JSON.parse(readFileSync(PROCESS_IDENTITY_CACHE_PATH, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cache = parsed;
    } catch (_) {}
    const now = Date.now();
    for (const [key, entry] of Object.entries(cache)) {
      if (!entry || typeof entry !== "object" || !Number.isFinite(Number(entry.checkedAt)) || now - Number(entry.checkedAt) >= PROCESS_IDENTITY_CACHE_TTL_MS) {
        delete cache[key];
      }
    }
    cache[String(pid)] = { value, checkedAt: now };
    const temporaryPath = PROCESS_IDENTITY_CACHE_PATH + ".tmp-" + process.pid + "-" + now + "-" + Math.random().toString(36).slice(2);
    writeFileSync(temporaryPath, JSON.stringify(cache), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      renameSync(temporaryPath, PROCESS_IDENTITY_CACHE_PATH);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch (_) {}
      throw error;
    }
  } catch (error) {
    recordHandlerError("process-identity-cache", error, [PROCESS_IDENTITY_CACHE_PATH]);
  }
}

function readLinuxProcessStartIdentity(pid) {
  let raw;
  try {
    raw = readFileSync("/proc/" + pid + "/stat", "utf8");
  } catch (error) {
    return error && error.code === "ENOENT" ? { status: "dead" } : { status: "unknown" };
  }
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) return { status: "unknown" };
  const fields = raw.slice(commandEnd + 1).trim().split(/\\s+/);
  const startTicks = fields[19];
  if (!/^\\d+$/.test(startTicks || "")) return { status: "unknown" };

  let bootId;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (_) {
    return { status: "unknown" };
  }
  if (!bootId || bootId.length > 256 || /\\s/.test(bootId)) return { status: "unknown" };
  return { status: "known", value: "linux:" + bootId + ":" + startTicks };
}

function readDarwinProcessStartIdentity(pid) {
  const result = spawnSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    darwinProcessIdentityScript(pid)
  ], {
    encoding: "utf8",
    timeout: PROCESS_IDENTITY_TIMEOUT_MS,
    killSignal: "SIGKILL"
  });
  if (result.error || result.status == null) return { status: "unknown" };
  if (result.status !== 0) return processIdentityFailureStatus(pid);

  const encoded = String(result.stdout || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return { status: "unknown" };
  }
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== DARWIN_PROCESS_INFO_SIZE) return { status: "unknown" };
    const seconds = bytes.readBigUInt64LE(DARWIN_START_SECONDS_OFFSET);
    const microseconds = bytes.readBigUInt64LE(DARWIN_START_MICROSECONDS_OFFSET);
    if (seconds <= 0n || microseconds >= 1000000n) return { status: "unknown" };
    return { status: "known", value: "darwin:" + seconds + ":" + microseconds };
  } catch (_) {
    return { status: "unknown" };
  }
}

function darwinProcessIdentityScript(pid) {
  return "ObjC.import(\\\"Foundation\\\"); const procPidInfoTypes = [\\\"int\\\", [\\\"int\\\", \\\"int\\\", \\\"unsigned long\\\", \\\"pointer\\\", \\\"int\\\"]]; try { ObjC.bindFunction(\\\"proc_pidinfo\\\", procPidInfoTypes); } catch (_) { ObjC.bindFunction(\\\"proc_pidinfo\\\", procPidInfoTypes, \\\"/usr/lib/libproc.dylib\\\"); } const data = $.NSMutableData.dataWithLength(" + DARWIN_PROCESS_INFO_SIZE + "); const size = $.proc_pidinfo(" + pid + ", 3, 0, data.mutableBytes, " + DARWIN_PROCESS_INFO_SIZE + "); if (size !== " + DARWIN_PROCESS_INFO_SIZE + ") { throw new Error(\\\"proc_pidinfo unavailable\\\") }; ObjC.unwrap(data.base64EncodedStringWithOptions(0));";
}

function processIdentityFailureStatus(pid) {
  try {
    process.kill(pid, 0);
    return { status: "unknown" };
  } catch (error) {
    return error && error.code === "ESRCH" ? { status: "dead" } : { status: "unknown" };
  }
}

function readWindowsProcessStartIdentity(pid) {
  const configuredRoot = typeof process.env.SystemRoot === "string" ? process.env.SystemRoot.trim() : "";
  const systemRoot = /^[A-Za-z]:[\\\\/]/.test(configuredRoot)
    ? configuredRoot
    : "C:\\\\Windows";
  const powershell = windowsPath.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const command = "try { $process = Get-Process -Id " + pid + " -ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks) } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 }; exit 4 }";
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command
  ], {
    encoding: "utf8",
    timeout: PROCESS_IDENTITY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true
  });
  if (result.error) return { status: "unknown" };
  if (result.status === 3) return { status: "dead" };
  if (result.status !== 0) return { status: "unknown" };
  const ticks = String(result.stdout || "").trim();
  return /^\\d+$/.test(ticks) ? { status: "known", value: "windows:" + ticks } : { status: "unknown" };
}

function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  if (process.platform === "win32") {
    const result = spawnSync(TASKLIST_COMMAND, ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: TASKLIST_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      recordHandlerError(
        "process-liveness",
        result.error || new Error("tasklist exited with status " + String(result.status ?? "unknown")),
        [TASKLIST_COMMAND]
      );
      return true;
    }
    return String(result.stdout || "").includes('"' + pid + '"');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

function isSelfNotify(cmd) {
  return cmd.some((part) => {
    if (typeof part !== "string") return false;
    if (!part.includes("notify.cjs")) return false;
    if (part.includes(SELF_PATH)) return true;
    const homePath = SELF_PATH.startsWith(HOME_DIR) ? "~" + SELF_PATH.slice(HOME_DIR.length) : "";
    if (homePath && part.includes(homePath)) return true;
    const resolved = part.startsWith("~/") ? join(HOME_DIR, part.slice(2)) : resolve(part);
    return resolved === SELF_PATH;
  });
}

function recordHandlerError(stage, error, sensitiveValues = []) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const message = limitHandlerErrorMessage(redactErrorMessage(errorMessage(error), sensitiveValues));
    appendFileSync(HANDLER_ERROR_LOG_PATH, JSON.stringify({
      stage,
      message,
      at: new Date().toISOString(),
    }) + "\\n", "utf8");
    trimHandlerErrorLog();
  } catch (diagnosticError) {
    try {
      process.stderr.write("TokenBoard notify handler diagnostics unavailable: " +
        limitHandlerErrorMessage(redactErrorMessage(errorMessage(diagnosticError))) + "\\n");
    } catch (_) {}
  }
}

function limitHandlerErrorMessage(message) {
  if (message.length <= HANDLER_ERROR_MESSAGE_MAX_CHARS) return message;
  return message.slice(0, HANDLER_ERROR_MESSAGE_MAX_CHARS) + "...<truncated>";
}

function trimHandlerErrorLog() {
  let fileDescriptor;
  let temporaryPath;
  let temporaryDescriptor;
  try {
    fileDescriptor = openSync(HANDLER_ERROR_LOG_PATH, "r");
    const size = fstatSync(fileDescriptor).size;
    if (size <= HANDLER_ERROR_LOG_MAX_BYTES) return;
    const buffer = Buffer.alloc(HANDLER_ERROR_LOG_MAX_BYTES);
    const bytes = readSync(
      fileDescriptor,
      buffer,
      0,
      buffer.length,
      Math.max(0, size - HANDLER_ERROR_LOG_MAX_BYTES)
    );
    // Windows does not allow replacing a file while its read handle is open.
    // Close the source before publishing the bounded replacement; the content
    // has already been copied into memory and the temporary file is exclusive.
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    let offset = 0;
    while (offset < bytes && buffer[offset] !== 10) offset += 1;
    if (offset < bytes) offset += 1;
    temporaryPath = HANDLER_ERROR_LOG_PATH + ".trim-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    temporaryDescriptor = openSync(temporaryPath, "wx", 0o600);
    if (bytes > offset) writeSync(temporaryDescriptor, buffer, offset, bytes - offset, 0);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    renameSync(temporaryPath, HANDLER_ERROR_LOG_PATH);
    temporaryPath = undefined;
  } finally {
    if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor);
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (temporaryPath !== undefined) {
      try { unlinkSync(temporaryPath); } catch (_) {}
    }
  }
}

function redactErrorMessage(message, sensitiveValues = []) {
  const values = [
    STATE_DIR,
    SIGNAL_DIR,
    DISPATCH_LOCK_PATH,
    DISPATCH_WORKER_PATH,
    TASKLIST_COMMAND,
    NODE_PATH,
    NOTIFY_SCRIPT,
    SELF_PATH,
    HOME_DIR,
    ...sensitiveValues,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  return values.reduce((current, value) => current.split(value).join("<redacted>"), message);
}

function errorMessage(error) {
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch (_) {}
  if (!isError) return safeErrorString(error);

  const message = safeErrorPropertyString(error, "message");
  if (message.trim()) return message;
  const name = safeErrorPropertyString(error, "name");
  if (name.trim()) return name;
  return "Unknown error";
}

function safeErrorPropertyString(error, property) {
  try {
    return String(error[property] ?? "");
  } catch (_) {
    return "";
  }
}

function safeErrorString(value) {
  try {
    const message = String(value);
    return message.trim() ? message : "Unknown error";
  } catch (_) {
    return "Unknown error";
  }
}

function isMissingFileError(error) {
  return error && error.code === "ENOENT";
}

function writeQueuedSignal(payload, source) {
  mkdirSync(SIGNAL_DIR, { recursive: true, mode: 0o700 });
  const name = Date.now() + "-" + process.pid + "-" + Math.random().toString(36).slice(2);
  const tempPath = join(SIGNAL_DIR, "." + name + ".tmp");
  const finalPath = join(SIGNAL_DIR, source + ".json");
  writeFileSync(tempPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    renameSync(tempPath, finalPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch (_) {}
    throw error;
  }
}
`
}

function validateHookTargets({ sources, paths, fs }) {
  if (sources.includes(codexSource)) {
    assertCodexNotifyWritable({ paths, fs })
  }
  if (sources.includes(claudeSource)) {
    assertClaudeSettingsValid({ paths, fs })
  }
  if (sources.includes(antigravitySource)) {
    assertAntigravitySettingsValid({ paths, fs })
  }
}

function validateUninstallHookTargets({ sources, explicitAntigravity, paths, fs }) {
  if (sources.includes(codexSource)) {
    assertCodexNotifyWritable({ paths, fs })
  }
  if (sources.includes(claudeSource)) {
    assertClaudeSettingsValid({ paths, fs })
  }
  if (sources.includes(antigravitySource) && explicitAntigravity) {
    assertAntigravitySettingsValid({ paths, fs })
  }
}

function sourceWasExplicitlyRequested(value, source) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .includes(source)
}

function canRemoveNotifyHandler(status) {
  return status.codex === 'not-installed' && status.claudeCode === 'not-installed'
}

function needsNotifyHandler(sources) {
  return sources.includes(codexSource) || sources.includes(claudeSource)
}

function getAntigravityGuiStatus(path, fs) {
  if (!path) return 'not-installed'
  try {
    return pathExists(path, fs) ? 'installed-local-history' : 'not-installed'
  } catch {
    return 'error'
  }
}

function pathExists(path, fs) {
  if (typeof fs.exists === 'function') return fs.exists(path)
  return readOptional(path, fs) !== null
}

function resolveEnvPath(value) {
  return typeof value === 'string' && value.trim() ? resolve(value) : null
}

function runCli(command) {
  try {
    const result = command()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

export function runInstallHooksCli() {
  runCli(() => installHooks())
}

export function runUninstallHooksCli() {
  runCli(() => uninstallHooks())
}
