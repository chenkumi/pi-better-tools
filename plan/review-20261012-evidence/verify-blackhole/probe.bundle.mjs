var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// modules/blackhole/src/om/cleanup.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join2, resolve, sep } from "node:path";
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";
function extractSessionId(filename) {
  if (filename.endsWith(STALE_SUFFIX2)) {
    return filename.slice(0, -STALE_SUFFIX2.length) || null;
  }
  if (filename.endsWith(PENDING_SUFFIX2)) {
    return filename.slice(0, -PENDING_SUFFIX2.length) || null;
  }
  return null;
}
function scanPendingFiles(agentDir = getAgentDir2()) {
  const dir2 = join2(agentDir, PENDING_DIR2);
  if (!existsSync2(dir2)) return [];
  const results = [];
  let entries;
  try {
    entries = readdirSync2(dir2);
  } catch {
    return [];
  }
  for (const filename of entries) {
    const sessionId = extractSessionId(filename);
    if (!sessionId) continue;
    const filePath = join2(dir2, filename);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    results.push({
      sessionId,
      filename,
      path: filePath,
      isStale: filename.endsWith(STALE_SUFFIX2),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}
function scanSessionDir(dir2) {
  const ids = /* @__PURE__ */ new Set();
  if (!existsSync2(dir2)) return ids;
  const stack = [dir2];
  while (stack.length > 0) {
    const current = stack.pop();
    let names;
    try {
      names = readdirSync2(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const fullPath = join2(current, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(fullPath);
      } else if (st.isFile() && name.endsWith(".jsonl")) {
        try {
          const fd = readFileSync2(fullPath, "utf-8");
          const newlineIdx = fd.indexOf("\n");
          const firstLine2 = newlineIdx >= 0 ? fd.slice(0, newlineIdx) : fd;
          const header = JSON.parse(firstLine2);
          if (header.type === "session" && typeof header.id === "string" && header.id.length > 0) {
            ids.add(header.id);
          }
        } catch {
        }
      }
    }
  }
  return ids;
}
function readSettingsSessionDir() {
  try {
    const settingsPath = join2(getAgentDir2(), "settings.json");
    if (!existsSync2(settingsPath)) return void 0;
    const raw = JSON.parse(readFileSync2(settingsPath, "utf-8"));
    const dir2 = raw.sessionDir;
    if (typeof dir2 === "string" && dir2.trim().length > 0) {
      const expanded = dir2.startsWith("~") ? join2(process.env.HOME ?? "/home", dir2.slice(2)) : dir2;
      return resolve(expanded);
    }
  } catch {
  }
  return void 0;
}
function getDefaultSessionsDir() {
  return join2(getAgentDir2(), "sessions");
}
function findSessionDirs() {
  const dirs = [];
  const default_ = getDefaultSessionsDir();
  dirs.push(default_);
  const custom = readSettingsSessionDir();
  if (custom && custom !== default_ && existsSync2(custom)) {
    dirs.push(custom);
  }
  return dirs;
}
function collectAllSessionIds(sessionDirs) {
  const dirs = sessionDirs ?? findSessionDirs();
  const allIds = /* @__PURE__ */ new Set();
  for (const dir2 of dirs) {
    const ids = scanSessionDir(dir2);
    for (const id of ids) allIds.add(id);
  }
  return allIds;
}
function crossReference(pending, sessionIds) {
  const orphaned = [];
  const active = [];
  for (const pf of pending) {
    if (sessionIds.has(pf.sessionId)) {
      active.push(pf);
    } else {
      orphaned.push(pf);
    }
  }
  return { all: pending, orphaned, active };
}
function analyzeOrphaned(agentDir, sessionDirs) {
  const pending = scanPendingFiles(agentDir);
  if (pending.length === 0) {
    return { all: [], orphaned: [], active: [] };
  }
  const sessionIds = collectAllSessionIds(sessionDirs);
  return crossReference(pending, sessionIds);
}
function validateDeletionPaths(sessionId, pendingDir) {
  if (!sessionId || typeof sessionId !== "string") return { ok: false };
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return { ok: false };
  const resolvedDir = resolve(pendingDir);
  const pendingPath2 = join2(resolvedDir, `${sessionId}${PENDING_SUFFIX2}`);
  const stalePath2 = join2(resolvedDir, `${sessionId}${STALE_SUFFIX2}`);
  const resolvedPending = resolve(pendingPath2);
  const resolvedStale = resolve(stalePath2);
  if (!resolvedPending.startsWith(resolvedDir + sep)) return { ok: false };
  if (!resolvedStale.startsWith(resolvedDir + sep)) return { ok: false };
  return { ok: true, pendingPath: resolvedPending, stalePath: resolvedStale };
}
function deletePendingFiles(sessionId, agentDir) {
  const dir2 = join2(agentDir ?? getAgentDir2(), PENDING_DIR2);
  const valid = validateDeletionPaths(sessionId, dir2);
  if (!valid.ok) return false;
  const { pendingPath: pendingPath2, stalePath: stalePath2 } = valid;
  let deleted = false;
  try {
    if (existsSync2(pendingPath2)) {
      unlinkSync2(pendingPath2);
      deleted = true;
    }
  } catch {
  }
  try {
    if (existsSync2(stalePath2)) {
      unlinkSync2(stalePath2);
      deleted = true;
    }
  } catch {
  }
  return deleted;
}
function deleteOrphanedBatch(orphaned, agentDir) {
  let count = 0;
  for (const pf of orphaned) {
    if (deletePendingFiles(pf.sessionId, agentDir)) {
      count++;
    }
  }
  return count;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatAge(mtimeMs, nowMs = Date.now()) {
  const diffMs = nowMs - mtimeMs;
  const seconds = Math.floor(diffMs / 1e3);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
function describeFile(pf, nowMs) {
  const label = pf.isStale ? "stale" : "pending";
  return `${pf.sessionId.slice(0, 8)}\u2026 ${label}  ${formatSize(pf.sizeBytes)}  ${formatAge(pf.mtimeMs, nowMs)}`;
}
var PENDING_DIR2, PENDING_SUFFIX2, STALE_SUFFIX2, SAFE_SESSION_ID_RE;
var init_cleanup = __esm({
  "modules/blackhole/src/om/cleanup.ts"() {
    "use strict";
    PENDING_DIR2 = "pi-blackhole";
    PENDING_SUFFIX2 = "-pending.json";
    STALE_SUFFIX2 = "-pending.stale.json";
    SAFE_SESSION_ID_RE = /^[a-zA-Z0-9][-a-zA-Z0-9]*$/;
  }
});

// modules/blackhole/src/core/project-trust.ts
import { resolve as resolve2 } from "node:path";
function hostProjectTrust(ctx) {
  try {
    const fn = ctx?.isProjectTrusted;
    return typeof fn === "function" ? fn.call(ctx) === true : false;
  } catch {
    return false;
  }
}
function recordProjectTrust(cwd, ctx) {
  const trusted = hostProjectTrust(ctx);
  if (cwd) decisions.set(key(cwd), trusted);
  return trusted;
}
function isProjectLayerAdmitted(cwd) {
  return !!cwd && decisions.get(key(cwd)) === true;
}
var decisions, key;
var init_project_trust = __esm({
  "modules/blackhole/src/core/project-trust.ts"() {
    "use strict";
    decisions = /* @__PURE__ */ new Map();
    key = (cwd) => {
      const normalized = resolve2(cwd);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
  }
});

// modules/blackhole/src/core/pi-owned-settings.ts
function canonicalPersistedSettings(raw) {
  const result = { ...raw };
  for (const key2 of IGNORED_CONTROL_KEYS) delete result[key2];
  return result;
}
function piOwnedSettingsWarning(raw) {
  const present = legacyTimingKeys.filter((key2) => raw[key2] !== void 0);
  if (!present.length) return;
  return `blackhole: Pi owns compaction timing and retained context. Legacy settings (${present.join(", ")}) are readable but do not control this mode. Configure Pi compaction.enabled/reserveTokens/keepRecentTokens instead; no Blackhole threshold is applied.`;
}
var legacyTimingKeys, IGNORED_CONTROL_KEYS;
var init_pi_owned_settings = __esm({
  "modules/blackhole/src/core/pi-owned-settings.ts"() {
    "use strict";
    legacyTimingKeys = ["compactAfterTokens", "compactAfterRatio", "compactReserveTokens", "compactAfterPreset", "compactAfterPresets", "midRunCompaction", "tailBehavior", "retainedToolOutputMaxTokens"];
    IGNORED_CONTROL_KEYS = legacyTimingKeys.filter((key2) => key2 !== "compactAfterPresets");
  }
});

// modules/blackhole/src/pi-base/paths.ts
import { getAgentDir as getAgentDir3 } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
function vitestExtensionsDir() {
  const existing = cachedVitestExtensionsDir;
  if (existing) return existing;
  const dir2 = mkdtempSync(join3(tmpdir(), "pi-agent-extensions-"));
  cachedVitestExtensionsDir = dir2;
  process.once("exit", () => rmSync(dir2, { recursive: true, force: true }));
  return dir2;
}
function getPiAgentDir() {
  const currentEnvVal = process.env.PI_CODING_AGENT_DIR;
  if (cachedPiAgentDir !== null && currentEnvVal === lastEnvVal) {
    return cachedPiAgentDir;
  }
  lastEnvVal = currentEnvVal;
  cachedPiAgentDir = currentEnvVal?.trim() || getAgentDir3();
  return cachedPiAgentDir;
}
function getExtensionsDir() {
  if (process.env.VITEST === "true" && !process.env.PI_CODING_AGENT_DIR) {
    return vitestExtensionsDir();
  }
  return join3(getPiAgentDir(), "extensions");
}
var lastEnvVal, cachedPiAgentDir, cachedVitestExtensionsDir;
var init_paths = __esm({
  "modules/blackhole/src/pi-base/paths.ts"() {
    "use strict";
    lastEnvVal = void 0;
    cachedPiAgentDir = null;
  }
});

// modules/blackhole/src/pi-base/session.ts
function getAncestorChain(entries, leafId) {
  const byId = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "session") continue;
    byId.set(entry.id, { id: entry.id, parentId: entry.parentId ?? null });
  }
  const chain = [];
  let current = byId.get(leafId);
  const visited = /* @__PURE__ */ new Set();
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    chain.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : void 0;
  }
  return chain;
}
var init_session = __esm({
  "modules/blackhole/src/pi-base/session.ts"() {
    "use strict";
  }
});

// modules/blackhole/src/pi-base/config.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join4, sep as sep2 } from "node:path";
import { tmpdir as tmpdir2 } from "node:os";
function cacheSet(key2, value) {
  _configCache.delete(key2);
  _configCache.set(key2, value);
  if (_configCache.size > CACHE_LIMIT) {
    const firstKey = _configCache.keys().next().value;
    if (firstKey !== void 0) {
      _configCache.delete(firstKey);
    }
  }
}
function resolveConfigDir(configDir) {
  return configDir ?? getExtensionsDir();
}
function isRealDir(dir2) {
  if (dir2.startsWith("/tmp") || dir2.startsWith("/var/folders")) return false;
  const systemTmp = tmpdir2();
  return dir2 !== systemTmp && !dir2.startsWith(systemTmp + sep2);
}
function guardRealDir(filename, configDir, operation) {
  if (configDir !== void 0) return true;
  if (process.env.VITEST !== "true") return true;
  const dir2 = resolveConfigDir(configDir);
  if (isRealDir(dir2)) {
    console.warn(
      `[pi-base] Blocked ${operation} of "${filename}" \u2014 running in vitest without explicit configDir, and the target directory (${dir2}) looks like a real user home. Pass an explicit configDir parameter to enable ${operation}s in tests.`
    );
    return false;
  }
  return true;
}
function readConfig(filename, configDir) {
  const path = join4(resolveConfigDir(configDir), filename);
  try {
    const stats = statSync2(path, { throwIfNoEntry: false });
    if (!stats) {
      _configCache.delete(path);
      return null;
    }
    const hit = _configCache.get(path);
    if (hit && hit.mtime === stats.mtimeMs && hit.size === stats.size) {
      _configCache.delete(path);
      _configCache.set(path, hit);
      return structuredClone(hit.data);
    }
    const raw = readFileSync3(path, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      cacheSet(path, { data: null, mtime: stats.mtimeMs, size: stats.size });
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      cacheSet(path, { data: null, mtime: stats.mtimeMs, size: stats.size });
      return null;
    }
    cacheSet(path, {
      data: structuredClone(parsed),
      mtime: stats.mtimeMs,
      size: stats.size
    });
    return parsed;
  } catch {
    _configCache.delete(path);
    return null;
  }
}
function writeConfig(filename, data, configDir) {
  if (!guardRealDir(filename, configDir, "write")) return false;
  const path = join4(resolveConfigDir(configDir), filename);
  _configCache.delete(path);
  try {
    mkdirSync2(dirname(path), { recursive: true });
    writeFileSync2(path, `${JSON.stringify(data, null, 2)}
`, "utf-8");
    return true;
  } catch (error) {
    console.warn(
      `[pi-base] Failed to write "${path}": ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
function deleteConfig(filename, configDir) {
  if (!guardRealDir(filename, configDir, "delete")) return;
  const path = join4(resolveConfigDir(configDir), filename);
  _configCache.delete(path);
  try {
    rmSync2(path, { force: true });
  } catch {
  }
}
function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== "object") {
    return { ...base };
  }
  const result = { ...base };
  for (const key2 of Object.keys(overrides)) {
    if (PROTECTED_KEYS.has(key2)) continue;
    const overrideVal = overrides[key2];
    if (overrideVal === void 0) {
      continue;
    }
    if (overrideVal === null) {
      result[key2] = null;
      continue;
    }
    const baseVal = result[key2];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key2] = deepMerge(
        baseVal,
        overrideVal
      );
    } else {
      result[key2] = overrideVal;
    }
  }
  return result;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function sessionKey(namespace, cwd, sessionId, leafId) {
  return `${namespace}${SESSION_KEY_SEP}${cwd}${SESSION_KEY_SEP}${sessionId}${SESSION_KEY_SEP}${leafId}`;
}
function getSessionConfig(namespace, cwd, sessionId, leafId, entries) {
  const chain = getAncestorChain(entries, leafId);
  for (const id of chain) {
    const key2 = sessionKey(namespace, cwd, sessionId, id);
    const found = _sessionConfigs.get(key2);
    if (found) return found;
  }
  return {};
}
function setSessionConfig(namespace, cwd, sessionId, leafId, config2) {
  const key2 = sessionKey(namespace, cwd, sessionId, leafId);
  _sessionConfigs.set(key2, structuredClone(config2));
  if (_sessionConfigs.size > MAX_SESSION_CONFIGS) {
    const oldestKey = _sessionConfigs.keys().next().value;
    _sessionConfigs.delete(oldestKey);
  }
}
function getRawSessionConfig(namespace, cwd, sessionId, leafId) {
  return _sessionConfigs.get(sessionKey(namespace, cwd, sessionId, leafId));
}
function clearSessionConfig(namespace, cwd, sessionId, leafId) {
  _sessionConfigs.delete(sessionKey(namespace, cwd, sessionId, leafId));
}
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key2 of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key2)) return false;
      if (!deepEqual(a[key2], b[key2])) return false;
    }
    return true;
  }
  return false;
}
function checkConfigFile(filename, configDir) {
  const path = join4(resolveConfigDir(configDir), filename);
  try {
    const stats = statSync2(path, { throwIfNoEntry: false });
    if (!stats) {
      return { exists: false, valid: true };
    }
    const raw = readFileSync3(path, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { exists: true, valid: false, error: "Config file is empty" };
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return {
        exists: true,
        valid: false,
        error: `Invalid JSON: ${e.message}`
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        exists: true,
        valid: false,
        error: "Config file must contain a plain JSON object at the top level"
      };
    }
    return { exists: true, valid: true };
  } catch {
    return { exists: true, valid: false, error: "Cannot read config file" };
  }
}
function loadConfig(filename, defaults, opts = {}) {
  const dir2 = resolveConfigDir(opts.configDir);
  const mergeFn = opts.merge === "deep" ? (base, over) => deepMerge(
    base,
    over
  ) : shallowMerge;
  let config2 = defaults;
  config2 = mergeFn(config2, readConfig(filename, dir2) ?? {});
  if (opts.cwd && isProjectLayerAdmitted(opts.cwd)) {
    const projectDir = join4(opts.cwd, ".pi");
    config2 = mergeFn(config2, readConfig(filename, projectDir) ?? {});
  }
  return config2;
}
function shallowMerge(base, overrides) {
  const result = { ...base };
  for (const key2 of Object.keys(overrides)) {
    if (PROTECTED_KEYS.has(key2)) continue;
    const val = overrides[key2];
    if (val !== void 0) {
      result[key2] = val;
    }
  }
  return result;
}
function readBooleanEnv(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}
function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
var _configCache, CACHE_LIMIT, PROTECTED_KEYS, SESSION_KEY_SEP, PENDING_SENTINEL, _sessionConfigs, MAX_SESSION_CONFIGS;
var init_config = __esm({
  "modules/blackhole/src/pi-base/config.ts"() {
    "use strict";
    init_paths();
    init_project_trust();
    init_paths();
    init_session();
    _configCache = /* @__PURE__ */ new Map();
    CACHE_LIMIT = 128;
    PROTECTED_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
    SESSION_KEY_SEP = "\0";
    PENDING_SENTINEL = "__pending__";
    _sessionConfigs = /* @__PURE__ */ new Map();
    MAX_SESSION_CONFIGS = 500;
  }
});

// modules/blackhole/src/core/config-env.ts
function normalizeCacheRetention(v) {
  if (typeof v !== "string") return void 0;
  const canonical = v.trim().toLowerCase();
  return CACHE_RETENTION_VALUES.includes(canonical) ? canonical : void 0;
}
function applyEnvOverrides(config2, env, defaults) {
  const result = {
    ...config2
  };
  for (const [key2, value] of Object.entries(env)) {
    if (!value) continue;
    const defaultValue = defaults[key2];
    if (typeof value === "string") {
      if (typeof defaultValue === "boolean") {
        result[key2] = readBooleanEnv(value, result[key2] ?? defaultValue);
      } else if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          result[key2] = readPositiveIntEnv(
            value,
            result[key2] ?? defaultValue
          );
        } else {
          const raw = process.env[value]?.trim();
          if (raw) {
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
              result[key2] = parsed;
            }
          }
        }
      }
    } else {
      const raw = process.env[value.var]?.trim();
      if (raw) {
        const parsed = value.parse(raw, result[key2]);
        if (parsed !== void 0) {
          result[key2] = parsed;
        }
      }
    }
  }
  return result;
}
var CACHE_RETENTION_VALUES, MAX_TIMER_DELAY_MS, DECLARATIVE_ENV_OVERRIDES;
var init_config_env = __esm({
  "modules/blackhole/src/core/config-env.ts"() {
    "use strict";
    init_config();
    CACHE_RETENTION_VALUES = ["none", "short", "long"];
    MAX_TIMER_DELAY_MS = 2147483647;
    DECLARATIVE_ENV_OVERRIDES = {
      // Booleans
      memory: "PI_BLACKHOLE_MEMORY",
      debug: "PI_BLACKHOLE_DEBUG",
      debugLog: "PI_BLACKHOLE_DEBUG_LOG",
      sessionFallback: "PI_BLACKHOLE_SESSION_FALLBACK",
      fullFoldAlways: "PI_BLACKHOLE_FULL_FOLD_ALWAYS",
      showPreCompactionMessage: "PI_BLACKHOLE_SHOW_PRE_COMPACTION_MESSAGE",
      statusBar: "PI_BLACKHOLE_STATUSBAR",
      showWorkerNotifications: "PI_BLACKHOLE_SHOW_WORKER_NOTIFICATIONS",
      // Positive integers
      compactAfterTokens: {
        // Parser (not the plain string form) so an UNSET var never re-injects the
        // 81000 default into derived mode: the string form falls back to the
        // DEFAULTS value when the env var is absent, resurrecting a deleted
        // compactAfterTokens. Only applied when the var is actually set.
        var: "PI_BLACKHOLE_COMPACT_AFTER_TOKENS",
        parse: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n > 0 ? n : void 0;
        }
      },
      // Float in (0, 1] — window-derived threshold ratio (issue #60)
      compactAfterRatio: {
        var: "PI_BLACKHOLE_COMPACT_AFTER_RATIO",
        parse: (raw) => {
          const n = Number.parseFloat(raw);
          return Number.isFinite(n) && n > 0 && n <= 1 ? n : void 0;
        }
      },
      // Positive integer — window headroom reserve (issue #60)
      compactReserveTokens: {
        var: "PI_BLACKHOLE_COMPACT_RESERVE_TOKENS",
        parse: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n > 0 ? n : void 0;
        }
      },
      // Non-empty string — preset-curve selection knob (spec §4). Names are user
      // data; an unknown name warns at resolution and falls back to the built-in
      // "default" curve.
      compactAfterPreset: {
        var: "PI_BLACKHOLE_COMPACT_AFTER_PRESET",
        parse: (raw) => {
          const trimmed = raw.trim();
          return trimmed.length > 0 ? trimmed : void 0;
        }
      },
      retainedToolOutputMaxTokens: "PI_BLACKHOLE_RETAINED_TOOL_OUTPUT_MAX_TOKENS",
      recallResponseMaxChars: "PI_BLACKHOLE_RECALL_RESPONSE_MAX_CHARS",
      observeAfterTokens: "PI_BLACKHOLE_OBSERVE_AFTER_TOKENS",
      reflectAfterTokens: "PI_BLACKHOLE_REFLECT_AFTER_TOKENS",
      observationsPoolMaxTokens: "PI_BLACKHOLE_OBSERVATIONS_POOL_MAX_TOKENS",
      reflectionsPoolMaxTokens: {
        var: "PI_BLACKHOLE_REFLECTIONS_POOL_MAX_TOKENS",
        parse: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 ? n : void 0;
        }
      },
      observationsPoolTargetTokens: "PI_BLACKHOLE_OBSERVATIONS_POOL_TARGET_TOKENS",
      reflectorInputMaxTokens: "PI_BLACKHOLE_REFLECTOR_INPUT_MAX_TOKENS",
      dropperInputMaxTokens: "PI_BLACKHOLE_DROPPER_INPUT_MAX_TOKENS",
      observerChunkMaxTokens: "PI_BLACKHOLE_OBSERVER_CHUNK_MAX_TOKENS",
      observerPreambleMaxTokens: "PI_BLACKHOLE_OBSERVER_PREAMBLE_MAX_TOKENS",
      agentMaxTurns: "PI_BLACKHOLE_AGENT_MAX_TURNS",
      // Non-negative integer (0 = disabled, unset = inherit pi default)
      providerIdleTimeoutMs: {
        var: "PI_BLACKHOLE_PROVIDER_IDLE_TIMEOUT_MS",
        parse: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 ? n : void 0;
        }
      },
      // Non-negative integer up to Node's timer maximum (0 = disabled, unset =
      // no hard elapsed deadline)
      workerAttemptTimeoutMs: {
        var: "PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS",
        parse: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 && n <= MAX_TIMER_DELAY_MS ? n : void 0;
        }
      },
      // Float in (0, 1]
      dropperPressureThreshold: {
        var: "PI_BLACKHOLE_DROPPER_PRESSURE_THRESHOLD",
        parse: (raw) => {
          const n = Number.parseFloat(raw);
          return Number.isFinite(n) && n > 0 && n <= 1 ? n : void 0;
        }
      },
      // Float in (0, 1]
      dropperPoolFullnessThreshold: {
        var: "PI_BLACKHOLE_DROPPER_POOL_FULLNESS_THRESHOLD",
        parse: (raw) => {
          const n = Number.parseFloat(raw);
          return Number.isFinite(n) && n > 0 && n <= 1 ? n : void 0;
        }
      },
      // Comma-separated provider skip list ("provider" or "provider:api")
      skipForProviders: {
        var: "PI_BLACKHOLE_SKIP_PROVIDERS",
        parse: (raw) => raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      },
      // Enum overrides — custom parsers because canonical only auto-handles
      // booleans and positive integers.
      compaction: {
        var: "PI_BLACKHOLE_COMPACTION",
        parse: (raw) => {
          const trimmed = raw.trim().toLowerCase();
          return ["auto", "manual", "off"].includes(trimmed) ? trimmed : void 0;
        }
      },
      compactionEngine: {
        var: "PI_BLACKHOLE_COMPACTION_ENGINE",
        parse: (raw) => {
          const trimmed = raw.trim().toLowerCase();
          return ["blackhole", "pi-default"].includes(trimmed) ? trimmed : void 0;
        }
      },
      compactionSummaryMode: {
        var: "PI_BLACKHOLE_COMPACTION_SUMMARY_MODE",
        parse: (raw) => {
          const trimmed = raw.trim().toLowerCase();
          return ["default", "append"].includes(trimmed) ? trimmed : void 0;
        }
      },
      midRunCompaction: {
        var: "PI_BLACKHOLE_MID_RUN_COMPACTION",
        parse: (raw) => {
          const trimmed = raw.trim().toLowerCase();
          return ["resume", "pause", "off"].includes(trimmed) ? trimmed : void 0;
        }
      },
      // Prompt-cache retention preference for the memory workers; an unsupported
      // value leaves the file value (or pi's effective setting) in place.
      cacheRetention: {
        var: "PI_BLACKHOLE_CACHE_RETENTION",
        parse: (raw) => normalizeCacheRetention(raw)
      }
    };
  }
});

// modules/blackhole/src/core/unified-config.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
import { getAgentDir as originalGetAgentDir } from "@earendil-works/pi-coding-agent";
function getAgentDir4() {
  const current = process.env.PI_CODING_AGENT_DIR?.trim();
  if (current === __lastAgentDirEnv && __cachedAgentDir !== null) return __cachedAgentDir;
  __lastAgentDirEnv = current;
  __cachedAgentDir = current || originalGetAgentDir();
  return __cachedAgentDir;
}
function configPath() {
  if (__testConfigDir) {
    return join5(__testConfigDir, CONFIG_DIR, CONFIG_FILE);
  }
  return join5(getAgentDir4(), CONFIG_DIR, CONFIG_FILE);
}
function isFixedTokenThreshold(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isWindowRatio(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
}
function isReserveTokens(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isCompaction(v) {
  return typeof v === "string" && COMPACTION_VALUES.includes(v);
}
function isCompactionEngine(v) {
  return typeof v === "string" && COMPACTION_ENGINE_VALUES.includes(v);
}
function isCompactionSummaryMode(v) {
  return typeof v === "string" && COMPACTION_SUMMARY_MODE_VALUES.includes(v);
}
function isTailBehavior(v) {
  return typeof v === "string" && TAIL_BEHAVIOR_VALUES.includes(v);
}
function isMidRunCompaction(v) {
  return typeof v === "string" && MID_RUN_COMPACTION_VALUES.includes(v);
}
function isRecord(v) {
  return typeof v === "object" && v !== null;
}
function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function isThinkingLevel(v) {
  return typeof v === "string" && THINKING_LEVELS.includes(v);
}
function positiveInt(v) {
  return Number.isInteger(v) && typeof v === "number" && v > 0 ? v : void 0;
}
function nonNegativeInt(v) {
  return Number.isInteger(v) && typeof v === "number" && v >= 0 ? v : void 0;
}
function parseModel(v) {
  if (!isRecord(v)) return void 0;
  const provider = nonEmptyString(v.provider);
  const id = nonEmptyString(v.id);
  if (!provider || !id) return void 0;
  const model = { provider, id };
  if (isThinkingLevel(v.thinking)) model.thinking = v.thinking;
  const cooldown = nonNegativeInt(v.cooldownHours);
  if (cooldown !== void 0) model.cooldownHours = cooldown;
  const ctxWindow = positiveInt(v.contextWindow);
  if (ctxWindow !== void 0) model.contextWindow = ctxWindow;
  return model;
}
function parseModelArray(v) {
  if (!Array.isArray(v)) return void 0;
  const parsed = v.map(parseModel).filter((m) => m !== void 0);
  return parsed.length > 0 ? parsed : void 0;
}
function parsePresetAnchor(v) {
  if (!isRecord(v)) return void 0;
  const window = positiveInt(v.window);
  const ratio = v.ratio;
  if (window === void 0) return void 0;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    return void 0;
  }
  return { window, ratio };
}
function parsePresetDefinitions(v) {
  if (!isRecord(v)) return void 0;
  const out = {};
  for (const [name, body] of Object.entries(v)) {
    if (name.length === 0) continue;
    if (!Array.isArray(body)) {
      console.warn(`blackhole: compactAfterPresets["${name}"] is not an array; dropping preset`);
      continue;
    }
    const anchors = body.map(parsePresetAnchor).filter((a) => a !== void 0);
    if (anchors.length === 0) {
      console.warn(
        `blackhole: compactAfterPresets["${name}"] has no valid anchors; dropping preset`
      );
      continue;
    }
    anchors.sort((a, b) => a.window - b.window);
    const deduped = [];
    for (const a of anchors) {
      if (deduped.length > 0 && deduped[deduped.length - 1].window === a.window) {
        deduped[deduped.length - 1] = a;
      } else {
        deduped.push(a);
      }
    }
    out[name] = deduped;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeThresholdKnobs(rec, dropLegacyResidue = true) {
  const tokens = rec.compactAfterTokens;
  if (!isFixedTokenThreshold(tokens) || dropLegacyResidue && tokens === LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS) {
    delete rec.compactAfterTokens;
  }
  if (!isWindowRatio(rec.compactAfterRatio)) {
    delete rec.compactAfterRatio;
  }
  if (!isReserveTokens(rec.compactReserveTokens)) {
    delete rec.compactReserveTokens;
  }
  const preset = rec.compactAfterPreset;
  if (typeof preset !== "string" || preset.length === 0) {
    delete rec.compactAfterPreset;
  }
  const presets = parsePresetDefinitions(rec.compactAfterPresets);
  if (presets === void 0) {
    delete rec.compactAfterPresets;
  } else {
    rec.compactAfterPresets = presets;
  }
  const idle = rec.providerIdleTimeoutMs;
  if (!(typeof idle === "number" && Number.isInteger(idle) && idle >= 0)) {
    delete rec.providerIdleTimeoutMs;
  }
  const workerAttempt = rec.workerAttemptTimeoutMs;
  if (!(typeof workerAttempt === "number" && Number.isInteger(workerAttempt) && workerAttempt >= 0 && workerAttempt <= MAX_TIMER_DELAY_MS)) {
    delete rec.workerAttemptTimeoutMs;
  }
}
function parseConfig(raw) {
  const c = {};
  if (isCompaction(raw.compaction)) c.compaction = raw.compaction;
  if (isCompactionEngine(raw.compactionEngine)) c.compactionEngine = raw.compactionEngine;
  if (isCompactionSummaryMode(raw.compactionSummaryMode))
    c.compactionSummaryMode = raw.compactionSummaryMode;
  if (isTailBehavior(raw.tailBehavior)) c.tailBehavior = raw.tailBehavior;
  if (isMidRunCompaction(raw.midRunCompaction)) c.midRunCompaction = raw.midRunCompaction;
  const cacheRetention = normalizeCacheRetention(raw.cacheRetention);
  if (cacheRetention) c.cacheRetention = cacheRetention;
  const THRESHOLD_BLUNT_KEYS = [
    "compactAfterTokens",
    "compactAfterRatio",
    "compactReserveTokens",
    "compactAfterPreset",
    "compactAfterPresets",
    "providerIdleTimeoutMs",
    "workerAttemptTimeoutMs"
  ];
  if (Array.isArray(raw.skipForProviders)) {
    const list = raw.skipForProviders.filter((v) => typeof v === "string").map((v) => v.trim()).filter((v) => v.length > 0);
    if (list.length > 0) c.skipForProviders = list;
  }
  if (typeof raw.overrideDefaultCompaction === "boolean")
    c.overrideDefaultCompaction = raw.overrideDefaultCompaction;
  if (typeof raw.debug === "boolean") c.debug = raw.debug;
  if (typeof raw.sessionFallback === "boolean") c.sessionFallback = raw.sessionFallback;
  if (typeof raw.noAutoCompact === "boolean") c.noAutoCompact = raw.noAutoCompact;
  if (typeof raw.passive === "boolean") c.passive = raw.passive;
  if (typeof raw.memory === "boolean") c.memory = raw.memory;
  if (typeof raw.fullFoldAlways === "boolean") c.fullFoldAlways = raw.fullFoldAlways;
  if (typeof raw.debugLog === "boolean") c.debugLog = raw.debugLog;
  if (typeof raw.statusBar === "boolean") c.statusBar = raw.statusBar;
  if (typeof raw.showWorkerNotifications === "boolean")
    c.showWorkerNotifications = raw.showWorkerNotifications;
  const numKeys = [
    "observeAfterTokens",
    "reflectAfterTokens",
    "retainedToolOutputMaxTokens",
    "recallResponseMaxChars",
    "observationsPoolMaxTokens",
    "reflectionsPoolMaxTokens",
    "observationsPoolTargetTokens",
    "reflectorInputMaxTokens",
    "dropperInputMaxTokens",
    "observerChunkMaxTokens",
    "observerPreambleMaxTokens",
    "agentMaxTurns",
    "providerIdleTimeoutMs"
  ];
  if (typeof raw.dropperPressureThreshold === "number" && Number.isFinite(raw.dropperPressureThreshold) && raw.dropperPressureThreshold > 0 && raw.dropperPressureThreshold <= 1) {
    c.dropperPressureThreshold = raw.dropperPressureThreshold;
  }
  if (typeof raw.dropperPoolFullnessThreshold === "number" && Number.isFinite(raw.dropperPoolFullnessThreshold) && raw.dropperPoolFullnessThreshold > 0 && raw.dropperPoolFullnessThreshold <= 1) {
    c.dropperPoolFullnessThreshold = raw.dropperPoolFullnessThreshold;
  }
  for (const k of THRESHOLD_BLUNT_KEYS) {
    if (raw[k] !== void 0) c[k] = raw[k];
  }
  for (const k of numKeys) {
    const validator = k === "observerPreambleMaxTokens" || k === "providerIdleTimeoutMs" || k === "retainedToolOutputMaxTokens" || // 0 = disabled (opt-in)
    k === "recallResponseMaxChars" || // 0 = unbounded (opt-out)
    k === "reflectionsPoolMaxTokens" ? nonNegativeInt : positiveInt;
    const v = validator(raw[k]);
    if (v !== void 0) c[k] = v;
  }
  normalizeThresholdKnobs(c);
  const model = parseModel(raw.model);
  if (model) c.model = model;
  const obsModel = parseModel(raw.observerModel);
  if (obsModel) c.observerModel = obsModel;
  const refModel = parseModel(raw.reflectorModel);
  if (refModel) c.reflectorModel = refModel;
  const dropModel = parseModel(raw.dropperModel);
  if (dropModel) c.dropperModel = dropModel;
  const obsFallback = parseModelArray(raw.observerFallbackModels);
  if (obsFallback) c.observerFallbackModels = obsFallback;
  const refFallback = parseModelArray(raw.reflectorFallbackModels);
  if (refFallback) c.reflectorFallbackModels = refFallback;
  const dropFallback = parseModelArray(raw.dropperFallbackModels);
  if (dropFallback) c.dropperFallbackModels = dropFallback;
  return c;
}
function migrateOldKnobs(parsed) {
  if (parsed.compaction !== void 0 || parsed.compactionEngine !== void 0) {
    return;
  }
  if (parsed.passive === true) {
    parsed.compaction = "off";
    parsed.memory = false;
  } else if (parsed.noAutoCompact === true) {
    parsed.compaction = "manual";
  }
  if (parsed.overrideDefaultCompaction === true) {
    parsed.compactionEngine = "blackhole";
    if (parsed.tailBehavior === void 0) {
      parsed.tailBehavior = "minimal";
    }
  } else if (parsed.overrideDefaultCompaction === false) {
    parsed.compactionEngine = "pi-default";
  }
  delete parsed.passive;
  delete parsed.noAutoCompact;
  delete parsed.overrideDefaultCompaction;
}
function readJson(path) {
  if (!existsSync3(path)) return { data: null, error: null };
  try {
    return { data: JSON.parse(readFileSync4(path, "utf-8")), error: null };
  } catch (e) {
    const msg = `blackhole: config file at ${path} has invalid JSON: ${e.message}. Using defaults.`;
    console.warn(msg);
    return { data: null, error: msg };
  }
}
function loadUnifiedConfig(cwd, onWarn) {
  const path = configPath();
  let raw;
  let primaryError = null;
  const result = readJson(path);
  raw = result.data;
  primaryError = result.error;
  if (primaryError && onWarn) onWarn(primaryError);
  if (!raw) {
    const piVccPath = join5(getAgentDir4(), "pi-vcc-config.json");
    const piVccResult = readJson(piVccPath);
    const piVccRaw = piVccResult.data;
    if (piVccResult.error && onWarn) onWarn(piVccResult.error);
    const settingsPath = join5(getAgentDir4(), "settings.json");
    const settingsResult = readJson(settingsPath);
    const settingsRaw = settingsResult.data;
    if (settingsResult.error && onWarn) onWarn(settingsResult.error);
    const omRaw = settingsRaw?.["pi-blackhole"] ?? settingsRaw?.["observational-memory"];
    const projectAdmitted = isProjectLayerAdmitted(cwd);
    const projectSettingsPath = join5(cwd, ".pi", "settings.json");
    const projectResult2 = projectAdmitted ? readJson(projectSettingsPath) : { data: null, error: null };
    const projectRaw2 = projectResult2.data;
    if (projectResult2.error && onWarn) onWarn(projectResult2.error);
    const projectOmRaw = projectRaw2?.["pi-blackhole"] ?? projectRaw2?.["observational-memory"];
    const merged2 = {};
    if (piVccRaw && isRecord(piVccRaw)) Object.assign(merged2, piVccRaw);
    if (omRaw && isRecord(omRaw)) Object.assign(merged2, omRaw);
    if (projectOmRaw && isRecord(projectOmRaw)) Object.assign(merged2, projectOmRaw);
    raw = merged2;
  }
  const projectConfigPath = join5(cwd, ".pi", CONFIG_FILE);
  const projectResult = isProjectLayerAdmitted(cwd) ? readJson(projectConfigPath) : { data: null, error: null };
  const projectRaw = projectResult.data;
  if (projectResult.error && onWarn) onWarn(projectResult.error);
  if (projectRaw && isRecord(projectRaw)) {
    raw = { ...raw, ...projectRaw };
  }
  const timingWarning = piOwnedSettingsWarning(raw);
  if (timingWarning) {
    if (onWarn) onWarn(timingWarning);
    else console.warn(timingWarning);
  }
  const parsed = parseConfig(raw);
  migrateOldKnobs(parsed);
  const envPassive = process.env.PI_BLACKHOLE_PASSIVE ?? process.env.PI_VCC_OM_PASSIVE ?? process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
  if (envPassive !== void 0) {
    const v = envPassive.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) {
      parsed.compaction = "off";
      parsed.memory = false;
    } else if (["0", "false", "no", "off"].includes(v)) {
      if (raw?.passive === true) {
        delete parsed.compaction;
        delete parsed.memory;
      }
    }
  }
  const merged = { ...DEFAULTS, ...parsed };
  const envCompaction = process.env.PI_BLACKHOLE_COMPACTION;
  if (envCompaction !== void 0) {
    const trimmed = envCompaction.trim().toLowerCase();
    if (isCompaction(trimmed)) {
      merged.compaction = trimmed;
    } else {
      console.warn(`blackhole: invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`);
    }
  }
  const envCompactionEngine = process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
  if (envCompactionEngine !== void 0) {
    const trimmed = envCompactionEngine.trim().toLowerCase();
    if (isCompactionEngine(trimmed)) {
      merged.compactionEngine = trimmed;
    } else {
      console.warn(
        `blackhole: invalid PI_BLACKHOLE_COMPACTION_ENGINE value "${envCompactionEngine}"; ignoring`
      );
    }
  }
  const envMidRunCompaction = process.env.PI_BLACKHOLE_MID_RUN_COMPACTION;
  if (envMidRunCompaction !== void 0) {
    const trimmed = envMidRunCompaction.trim().toLowerCase();
    if (isMidRunCompaction(trimmed)) {
      merged.midRunCompaction = trimmed;
    } else {
      console.warn(
        `blackhole: invalid PI_BLACKHOLE_MID_RUN_COMPACTION value "${envMidRunCompaction}"; ignoring`
      );
    }
  }
  const withEnv = applyEnvOverrides(
    merged,
    DECLARATIVE_ENV_OVERRIDES,
    // SAFETY: DEFAULTS is a flat object literal (UnifiedConfig); its runtime
    // shape is exactly the Record<string, unknown> applyEnvOverrides expects.
    DEFAULTS
  );
  if (withEnv.memory !== false && withEnv.observeAfterTokens > withEnv.observerChunkMaxTokens) {
    const msg = `blackhole: observeAfterTokens (${withEnv.observeAfterTokens}) exceeds observerChunkMaxTokens (${withEnv.observerChunkMaxTokens}); the observer cannot see a full trigger's worth of content in one batch, so each observation pass runs in multiple batches. Raise observerChunkMaxTokens or lower observeAfterTokens if a single batch was intended.`;
    if (onWarn) onWarn(msg);
    else console.warn(msg);
  }
  const envTiming = Object.fromEntries([
    ["compactAfterTokens", "PI_BLACKHOLE_COMPACT_AFTER_TOKENS"],
    ["compactAfterRatio", "PI_BLACKHOLE_COMPACT_AFTER_RATIO"],
    ["compactReserveTokens", "PI_BLACKHOLE_COMPACT_RESERVE_TOKENS"],
    ["compactAfterPreset", "PI_BLACKHOLE_COMPACT_AFTER_PRESET"],
    ["midRunCompaction", "PI_BLACKHOLE_MID_RUN_COMPACTION"],
    ["retainedToolOutputMaxTokens", "PI_BLACKHOLE_RETAINED_TOOL_OUTPUT_MAX_TOKENS"]
  ].filter(([, env]) => process.env[env] !== void 0).map(([key2, env]) => [key2, process.env[env]]));
  const envWarning = piOwnedSettingsWarning(envTiming);
  if (envWarning) {
    if (onWarn) onWarn(envWarning);
    else console.warn(envWarning);
  }
  return withEnv;
}
function configFileNeedsMigration() {
  try {
    const path = configPath();
    if (!existsSync3(path)) return false;
    const raw = JSON.parse(readFileSync4(path, "utf-8"));
    if (raw.compaction !== void 0 || raw.compactionEngine !== void 0 || raw.tailBehavior !== void 0) {
      return false;
    }
    return raw.passive !== void 0 || raw.noAutoCompact !== void 0 || raw.overrideDefaultCompaction !== void 0;
  } catch {
    return false;
  }
}
function isManualMode(config2) {
  return config2.compaction === "manual" || config2.noAutoCompact === true;
}
var __lastAgentDirEnv, __cachedAgentDir, CONFIG_DIR, CONFIG_FILE, __testConfigDir, DEFAULTS, LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS, THINKING_LEVELS, COMPACTION_VALUES, COMPACTION_ENGINE_VALUES, COMPACTION_SUMMARY_MODE_VALUES, TAIL_BEHAVIOR_VALUES, MID_RUN_COMPACTION_VALUES;
var init_unified_config = __esm({
  "modules/blackhole/src/core/unified-config.ts"() {
    "use strict";
    init_project_trust();
    init_pi_owned_settings();
    init_config_env();
    __cachedAgentDir = null;
    CONFIG_DIR = "pi-blackhole";
    CONFIG_FILE = "pi-blackhole-config.json";
    DEFAULTS = {
      debug: false,
      sessionFallback: true,
      // Pi-owned mode is the only active factory path; these defaults provide BH summaries, not BH triggers.
      compaction: "auto",
      compactionEngine: "blackhole",
      compactionSummaryMode: "default",
      skipForProviders: [],
      tailBehavior: "minimal",
      showPreCompactionMessage: true,
      retainedToolOutputMaxTokens: 2e4,
      recallResponseMaxChars: 48e3,
      midRunCompaction: "off",
      observeAfterTokens: 15e3,
      reflectAfterTokens: 25e3,
      // The legacy fixed default (81000) is gone: the built-in "default" preset
      // curve governs when no numeric knob is configured (spec D3). An explicit
      // file/env compactAfterTokens still wins when present; a file-level 81000 is
      // scaffold residue from earlier versions and is always dropped (env-set 81000
      // stays explicit) — see normalizeThresholdKnobs.
      compactAfterTokens: void 0,
      // Window-derived knobs (issue #60) + preset-selection knob. Present here (as
      // defaults) so ConfigManager.save()'s diff-over-defaults can persist modal
      // edits — absence from DEFAULTS would silently drop a field edit. 0 is
      // treated as unset by normalizeThresholdKnobs. compactAfterPresets (the preset
      // DEFINITIONS) is deliberately NOT a DEFAULTS key — it is hand-edited JSON
      // that save() must carry verbatim (spec §4.2).
      compactAfterRatio: void 0,
      compactReserveTokens: void 0,
      compactAfterPreset: "default",
      observationsPoolMaxTokens: 2e4,
      reflectionsPoolMaxTokens: 8e3,
      fullFoldAlways: true,
      observationsPoolTargetTokens: 1e4,
      reflectorInputMaxTokens: 8e4,
      dropperInputMaxTokens: 8e4,
      dropperPressureThreshold: 0.7,
      dropperPoolFullnessThreshold: 0.1,
      observerChunkMaxTokens: 4e4,
      observerPreambleMaxTokens: 0,
      agentMaxTurns: 16,
      // Optional knobs must still be DEFAULTS members (as undefined) or
      // ConfigManager.save() — which diffs against Object.keys(DEFAULTS) —
      // silently drops them when saving from the settings modal.
      providerIdleTimeoutMs: void 0,
      workerAttemptTimeoutMs: void 0,
      cacheRetention: void 0,
      memory: true,
      debugLog: false,
      statusBar: true,
      showWorkerNotifications: true
    };
    LEGACY_SCAFFOLD_COMPACT_AFTER_TOKENS = 81e3;
    THINKING_LEVELS = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ];
    COMPACTION_VALUES = ["auto", "manual", "off"];
    COMPACTION_ENGINE_VALUES = ["blackhole", "pi-default"];
    COMPACTION_SUMMARY_MODE_VALUES = ["default", "append"];
    TAIL_BEHAVIOR_VALUES = ["pi-default", "minimal"];
    MID_RUN_COMPACTION_VALUES = ["resume", "pause", "off"];
  }
});

// modules/blackhole/src/om/model-budget.ts
function effectivePresets(cfg) {
  return { ...BUILTIN_PRESETS, ...cfg.compactAfterPresets };
}
function boundedMaxTokens(model, requested = AGENT_LOOP_MAX_TOKENS) {
  return typeof model.maxTokens === "number" && model.maxTokens > 0 ? Math.min(model.maxTokens, requested) : requested;
}
function effectiveContextWindow(resolvedModel, modelConfig) {
  if (modelConfig?.contextWindow !== void 0 && modelConfig.contextWindow > 0) {
    return modelConfig.contextWindow;
  }
  if (resolvedModel && typeof resolvedModel.contextWindow === "number" && resolvedModel.contextWindow > 0) {
    return resolvedModel.contextWindow;
  }
  return 128e3;
}
var AGENT_LOOP_MAX_TOKENS, BUILTIN_PRESETS;
var init_model_budget = __esm({
  "modules/blackhole/src/om/model-budget.ts"() {
    "use strict";
    init_unified_config();
    AGENT_LOOP_MAX_TOKENS = 32e3;
    BUILTIN_PRESETS = {
      default: [
        { window: 32768, ratio: 0.9 },
        { window: 131072, ratio: 0.8 },
        { window: 262144, ratio: 0.7 },
        { window: 1048576, ratio: 0.4 }
      ]
    };
  }
});

// synthetic:offline-observer
var offline_observer_exports = {};
__export(offline_observer_exports, {
  runObserver: () => runObserver
});
async function runObserver(input) {
  globalThis.__workerCalls = (globalThis.__workerCalls || 0) + 1;
  console.log("Progress: synthetic observer called");
  return { observations: [{ id: "bbbbbbbbbbbb", content: "Independent offline fact", timestamp: "2026-10-12T00:00:00Z", relevance: "high", sourceEntryIds: input.allowedSourceEntryIds, tokenCount: 5 }] };
}
var init_offline_observer = __esm({
  "synthetic:offline-observer"() {
  }
});

// synthetic:offline-reflector
var offline_reflector_exports = {};
__export(offline_reflector_exports, {
  runReflector: () => runReflector
});
async function runReflector() {
  console.log("Progress: synthetic reflector called");
  return { reflections: [] };
}
var init_offline_reflector = __esm({
  "synthetic:offline-reflector"() {
  }
});

// synthetic:offline-dropper
var offline_dropper_exports = {};
__export(offline_dropper_exports, {
  runDropper: () => runDropper
});
async function runDropper() {
  throw Error("Dropper unexpected in bounded fixture");
}
var init_offline_dropper = __esm({
  "synthetic:offline-dropper"() {
  }
});

// modules/blackhole/src/pi-base/core/config-env.ts
function applyEnvOverrides2(config2, env, defaults) {
  const result = {
    ...config2
  };
  for (const [key2, value] of Object.entries(env)) {
    if (!value) continue;
    const defaultValue = defaults[key2];
    if (typeof value === "string") {
      if (typeof defaultValue === "boolean") {
        result[key2] = readBooleanEnv(value, result[key2] ?? defaultValue);
      } else if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          result[key2] = readPositiveIntEnv(
            value,
            result[key2] ?? defaultValue
          );
        } else {
          const raw = process.env[value]?.trim();
          if (raw) {
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
              result[key2] = parsed;
            }
          }
        }
      }
    } else {
      const raw = process.env[value.var]?.trim();
      if (raw) {
        const parsed = value.parse(raw, result[key2]);
        if (parsed !== void 0) {
          result[key2] = parsed;
        }
      }
    }
  }
  return result;
}
var init_config_env2 = __esm({
  "modules/blackhole/src/pi-base/core/config-env.ts"() {
    "use strict";
    init_config();
  }
});

// modules/blackhole/src/pi-base/settings/frame.ts
import { truncateToWidth, visibleWidth, wrapTextWithAnsi as wrapTextWithAnsi2 } from "@earendil-works/pi-tui";
function frameContentWidth(width, paddingX = DEFAULT_PADDING_X) {
  return Math.max(1, width - 2 - paddingX * 2);
}
function pad2(text, width) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
function wrapLine(line, width) {
  const safeWidth = Math.max(1, width);
  const rawStr = String(line ?? "");
  const normalized = rawStr.includes("	") ? rawStr.replace(/\t/g, "  ") : rawStr;
  const parts = normalized.includes("\n") || normalized.includes("\r") ? normalized.split(/\r?\n/) : [normalized];
  const wrapped = parts.flatMap((part) => {
    const rows = wrapTextWithAnsi2(part, safeWidth);
    return rows.length > 0 ? rows : [""];
  });
  return wrapped.map((part) => truncateToWidth(part, safeWidth, ""));
}
function divider(width, theme) {
  return theme.fg("dim", "\u2500".repeat(Math.max(1, width)));
}
function formatHintLine(hints, theme) {
  return hints.map((h) => `${theme.fg("accent", h.key)} ${theme.fg("dim", h.label)}`).join(theme.fg("dim", " \xB7 "));
}
function frame(lines, width, theme, options = {}) {
  const paddingX = options.paddingX ?? DEFAULT_PADDING_X;
  const paddingY = options.paddingY ?? DEFAULT_PADDING_Y;
  const inner = Math.max(1, width - 2);
  const contentWidth = frameContentWidth(width, paddingX);
  const border = (s) => theme.fg("borderAccent", s);
  let body = lines;
  if (options.fixedInnerRows !== void 0 && body.length > options.fixedInnerRows) {
    const hidden = body.length - options.fixedInnerRows + 1;
    body = [
      ...body.slice(0, Math.max(0, options.fixedInnerRows - 1)),
      theme.fg("dim", `\u2193 ${hidden} more line(s)`)
    ].slice(0, options.fixedInnerRows);
  }
  const blank = `${border("\u2502")}${" ".repeat(inner)}${border("\u2502")}`;
  const top = () => {
    if (!options.title) return `${border("\u256D")}${border("\u2500".repeat(inner))}${border("\u256E")}`;
    const titlePlain = ` ${truncateToWidth(options.title, Math.max(1, inner - 4), "\u2026")} `;
    const titleVisible = visibleWidth(titlePlain);
    const leftDash = 2;
    const rightDash = Math.max(1, inner - leftDash - titleVisible);
    return `${border("\u256D")}${border("\u2500".repeat(leftDash))}${theme.fg("accent", theme.bold(titlePlain))}${border("\u2500".repeat(rightDash))}${border("\u256E")}`;
  };
  const out = [top()];
  if (options.subtitle) {
    for (const line of options.subtitle.split(/\r?\n/)) {
      const text = theme.fg("dim", pad2(truncateToWidth(line, contentWidth, "\u2026"), contentWidth));
      out.push(`${border("\u2502")}${" ".repeat(paddingX)}${text}${" ".repeat(paddingX)}${border("\u2502")}`);
    }
  }
  for (let i = 0; i < paddingY; i += 1) out.push(blank);
  for (const line of body) {
    out.push(
      `${border("\u2502")}${" ".repeat(paddingX)}${pad2(line, contentWidth)}${" ".repeat(paddingX)}${border("\u2502")}`
    );
  }
  for (let i = 0; i < paddingY; i += 1) out.push(blank);
  out.push(`${border("\u2570")}${border("\u2500".repeat(inner))}${border("\u256F")}`);
  return out.map((line) => truncateToWidth(line, width, ""));
}
function responsiveInnerRows(terminalRows, preferred, minimum = 12, ratio = 0.85) {
  const available = Math.max(
    minimum + FRAME_VERTICAL_CHROME,
    Math.floor(Math.max(1, terminalRows) * ratio)
  );
  return Math.max(minimum, Math.min(preferred, available - FRAME_VERTICAL_CHROME));
}
var DEFAULT_PADDING_X, DEFAULT_PADDING_Y, FRAME_VERTICAL_CHROME;
var init_frame = __esm({
  "modules/blackhole/src/pi-base/settings/frame.ts"() {
    "use strict";
    DEFAULT_PADDING_X = 1;
    DEFAULT_PADDING_Y = 1;
    FRAME_VERTICAL_CHROME = 2 + DEFAULT_PADDING_Y * 2;
  }
});

// modules/blackhole/src/pi-base/settings/confirm.ts
import { matchesKey } from "@earendil-works/pi-tui";
function createConfirm(options, done, args) {
  const confirmLabel = options.confirmLabel ?? "Confirm";
  const cancelLabel = options.cancelLabel ?? "Cancel";
  const isDanger = options.danger ?? false;
  const items = isDanger ? [
    { label: cancelLabel, confirmed: false },
    { label: confirmLabel, confirmed: true }
  ] : [
    { label: confirmLabel, confirmed: true },
    { label: cancelLabel, confirmed: false }
  ];
  let selectedIndex = 0;
  const render = (width) => {
    const contentWidth = Math.max(1, width - 2);
    const lines = [];
    lines.push("");
    for (const raw of options.message) {
      for (const wrapped of wrapLine(raw, contentWidth)) {
        const text = isDanger ? args.theme.fg("warning", wrapped) : wrapped;
        lines.push(`  ${text}`);
      }
    }
    lines.push("");
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? args.theme.fg("accent", "\u258C ") : "  ";
      const rawLabel = `${i + 1}. ${item.label}`;
      const label = isSelected ? args.theme.fg("text", rawLabel) : args.theme.fg("muted", rawLabel);
      const rowText = `${prefix}${label}`;
      if (isSelected) {
        lines.push(args.theme.bg("selectedBg", rowText));
      } else {
        lines.push(rowText);
      }
    }
    lines.push("");
    const hints = [
      { key: "\u2191\u2193", label: "select" },
      { key: "1-2/y/n", label: "choose" },
      { key: "enter/space", label: "confirm" },
      { key: "esc", label: "cancel" }
    ];
    lines.push(args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`));
    return lines;
  };
  const handleInput = (data) => {
    if (matchesKey(data, "up") || matchesKey(data, "left")) {
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "right")) {
      selectedIndex = (selectedIndex + 1) % items.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      done(items[selectedIndex].confirmed);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      done(false);
      return;
    }
    if (data === "1" || data === "2") {
      const idx = parseInt(data, 10) - 1;
      if (idx >= 0 && idx < items.length) {
        done(items[idx].confirmed);
        return;
      }
    }
    if (data === "y" || data === "Y") {
      const confirmItem = items.find((i) => i.confirmed);
      if (confirmItem) {
        done(confirmItem.confirmed);
        return;
      }
    }
    if (data === "n" || data === "N") {
      const cancelItem = items.find((i) => !i.confirmed);
      if (cancelItem) {
        done(cancelItem.confirmed);
        return;
      }
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
var init_confirm = __esm({
  "modules/blackhole/src/pi-base/settings/confirm.ts"() {
    "use strict";
    init_frame();
  }
});

// modules/blackhole/src/pi-base/settings/scope-selector.ts
import { matchesKey as matchesKey2 } from "@earendil-works/pi-tui";
function createScopeSelector(args) {
  const availableEntries = args.entries.filter((e) => e.available);
  let selectedAvailableIndex = 0;
  const render = (width) => {
    if (args.frame !== false) {
      const innerWidth = frameContentWidth(width);
      const bodyLines = [];
      bodyLines.push(divider(innerWidth, args.theme));
      for (let i = 0; i < args.entries.length; i += 1) {
        const entry = args.entries[i];
        const availableIndex = availableEntries.indexOf(entry);
        const isSelected = entry.available && availableIndex === selectedAvailableIndex;
        if (i > 0) bodyLines.push("");
        const prefix = isSelected ? args.theme.fg("accent", "\u258C ") : "  ";
        const numPrefix = availableIndex >= 0 && availableEntries.length <= 9 ? `${availableIndex + 1}. ` : "";
        let label = `${numPrefix}${entry.label}`;
        if (!entry.available) {
          label = args.theme.fg("dim", label);
        } else if (isSelected) {
          label = args.theme.fg("text", label);
        } else {
          label = args.theme.fg("muted", label);
        }
        const note = entry.note ? ` ${args.theme.fg("dim", entry.note)}` : "";
        bodyLines.push(`${prefix}${label}${note}`);
      }
      bodyLines.push("");
      const hints2 = [];
      if (availableEntries.length > 0) {
        hints2.push({ key: "\u2191\u2193", label: "select" });
        if (availableEntries.length > 1 && availableEntries.length <= 9) {
          hints2.push({ key: `1-${availableEntries.length}`, label: "choose" });
        }
        if (availableEntries.length > 2) {
          hints2.push({ key: "home/end", label: "top/bottom" });
        }
        hints2.push({ key: "enter/space", label: "confirm" });
      }
      hints2.push({ key: "esc", label: "cancel" });
      bodyLines.push(args.theme.fg("muted", `  ${formatHintLine(hints2, args.theme)}`));
      return frame(bodyLines, width, args.theme, {
        title: args.title,
        subtitle: args.subtitle
      });
    }
    const contentWidth = Math.max(1, width - UNFRAMED_CHROME_COLUMNS);
    const lines = [];
    lines.push("");
    if (args.subtitle) {
      for (const raw of args.subtitle.split(/\r?\n/)) {
        const text = args.theme.fg("dim", raw);
        lines.push(`  ${text}`);
      }
    }
    lines.push("");
    lines.push(divider(contentWidth, args.theme));
    for (let i = 0; i < args.entries.length; i += 1) {
      const entry = args.entries[i];
      const availableIndex = availableEntries.indexOf(entry);
      const isSelected = entry.available && availableIndex === selectedAvailableIndex;
      if (i > 0) lines.push("");
      const prefix = isSelected ? args.theme.fg("accent", "\u258C ") : "  ";
      const numPrefix = availableIndex >= 0 && availableEntries.length <= 9 ? `${availableIndex + 1}. ` : "";
      let label = `${numPrefix}${entry.label}`;
      if (!entry.available) {
        label = args.theme.fg("dim", label);
      } else if (isSelected) {
        label = args.theme.fg("text", label);
      } else {
        label = args.theme.fg("muted", label);
      }
      const note = entry.note ? ` ${args.theme.fg("dim", entry.note)}` : "";
      lines.push(`${prefix}${label}${note}`);
    }
    lines.push("");
    const hints = [];
    if (availableEntries.length > 0) {
      hints.push({ key: "\u2191\u2193", label: "select" });
      if (availableEntries.length > 1 && availableEntries.length <= 9) {
        hints.push({ key: `1-${availableEntries.length}`, label: "choose" });
      }
      if (availableEntries.length > 2) {
        hints.push({ key: "home/end", label: "top/bottom" });
      }
      hints.push({ key: "enter/space", label: "confirm" });
    }
    hints.push({ key: "esc", label: "cancel" });
    lines.push(args.theme.fg("muted", `  ${formatHintLine(hints, args.theme)}`));
    return lines;
  };
  const handleInput = (data) => {
    if (availableEntries.length === 0) {
      if (matchesKey2(data, "escape")) {
        args.done({ kind: "cancel" });
      }
      return;
    }
    if (matchesKey2(data, "up")) {
      selectedAvailableIndex = (selectedAvailableIndex - 1 + availableEntries.length) % availableEntries.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey2(data, "home")) {
      selectedAvailableIndex = 0;
      args.tui.requestRender();
      return;
    }
    if (matchesKey2(data, "end")) {
      selectedAvailableIndex = availableEntries.length - 1;
      args.tui.requestRender();
      return;
    }
    if (matchesKey2(data, "down")) {
      selectedAvailableIndex = (selectedAvailableIndex + 1) % availableEntries.length;
      args.tui.requestRender();
      return;
    }
    if (matchesKey2(data, "enter") || matchesKey2(data, "return") || data === " ") {
      const selected = availableEntries[selectedAvailableIndex];
      args.done({ kind: "select", id: selected.id });
      return;
    }
    if (matchesKey2(data, "escape")) {
      args.done({ kind: "cancel" });
      return;
    }
    if (/^[1-9]$/.test(data)) {
      const idx = parseInt(data, 10) - 1;
      if (idx >= 0 && idx < availableEntries.length) {
        const selected = availableEntries[idx];
        args.done({ kind: "select", id: selected.id });
        return;
      }
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
var UNFRAMED_CHROME_COLUMNS;
var init_scope_selector = __esm({
  "modules/blackhole/src/pi-base/settings/scope-selector.ts"() {
    "use strict";
    init_frame();
    UNFRAMED_CHROME_COLUMNS = 2;
  }
});

// modules/blackhole/src/pi-base/settings/fields/action.ts
import { matchesKey as matchesKey3 } from "@earendil-works/pi-tui";
var actionRenderer;
var init_action = __esm({
  "modules/blackhole/src/pi-base/settings/fields/action.ts"() {
    "use strict";
    actionRenderer = {
      type: "action",
      renderValue(row, { selected, ctx }) {
        const text = row.field.display ?? "(run)";
        if (row.field.disabled) {
          return ctx.theme.fg("muted", `${text} (unavailable)`);
        }
        return ctx.theme.fg(selected ? "accent" : "muted", text);
      },
      hints(row) {
        if (row.field.disabled) return [];
        return [{ key: "enter/space", label: "run" }];
      },
      handleKey(row, data, { ctx }) {
        if (row.field.disabled) return {};
        if (matchesKey3(data, "enter") || matchesKey3(data, "return") || data === " ") {
          try {
            const ret = row.field.onActivate(ctx.ctx);
            if (ret && typeof ret.then === "function") {
              ret.catch(() => {
              });
            }
          } catch {
          }
          return { consumed: true };
        }
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/boolean.ts
import { matchesKey as matchesKey4 } from "@earendil-works/pi-tui";
var booleanRenderer;
var init_boolean = __esm({
  "modules/blackhole/src/pi-base/settings/fields/boolean.ts"() {
    "use strict";
    booleanRenderer = {
      type: "boolean",
      renderValue(row, { selected, ctx }) {
        if (row.field.disabled) {
          const text = row.value ? "[\u2713] on" : "[ ] off";
          return ctx.theme.fg("muted", text);
        }
        if (row.value) {
          const indicator = ctx.theme.fg(selected ? "accent" : "success", "\u2713");
          const label = ctx.theme.fg(selected ? "accent" : "success", "on");
          return `[${indicator}] ${label}`;
        } else {
          const indicator = ctx.theme.fg(selected ? "accent" : "muted", " ");
          const label = ctx.theme.fg(selected ? "accent" : "muted", "off");
          return `[${indicator}] ${label}`;
        }
      },
      hints(row) {
        if (row.field.disabled) return [];
        return [
          { key: "enter/space", label: row.value ? "turn off" : "turn on" },
          { key: "\u2190/\u2192", label: "toggle" }
        ];
      },
      handleKey(row, data) {
        if (row.field.disabled) return {};
        if (matchesKey4(data, "enter") || matchesKey4(data, "return") || data === " ") {
          return { consumed: true, commit: !row.value };
        }
        if (matchesKey4(data, "left")) {
          if (row.value === false) return { consumed: true };
          return { consumed: true, commit: false };
        }
        if (matchesKey4(data, "right")) {
          if (row.value === true) return { consumed: true };
          return { consumed: true, commit: true };
        }
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/custom.ts
import { matchesKey as matchesKey5 } from "@earendil-works/pi-tui";
var customRenderer;
var init_custom = __esm({
  "modules/blackhole/src/pi-base/settings/fields/custom.ts"() {
    "use strict";
    customRenderer = {
      type: "custom",
      renderValue(row, args) {
        const text = row.field.render({
          value: row.value,
          width: args.width,
          selected: args.selected && !row.field.disabled,
          theme: args.ctx.theme
        });
        if (row.field.disabled) {
          return args.ctx.theme.fg("muted", text);
        }
        return text;
      },
      hints(row) {
        if (row.field.disabled) return [];
        if (row.field.hints) return row.field.hints;
        if (row.field.openSubmenu) return [{ key: "enter/space", label: "open" }];
        if (row.field.handleInput) return [{ key: "enter/space", label: "edit" }];
        return [];
      },
      handleKey(row, data, args) {
        if (row.field.disabled) return {};
        if (row.field.handleInput) {
          const consumed = row.field.handleInput(data, {
            value: row.value,
            width: 0,
            selected: true,
            theme: args.ctx.theme
          });
          if (consumed) return { consumed: true };
        }
        if (matchesKey5(data, "enter") || matchesKey5(data, "return") || data === " ") {
          if (row.field.openSubmenu) {
            const factory = (done) => row.field.openSubmenu({
              value: row.value,
              theme: args.ctx.theme,
              tui: args.ctx.tui,
              done
            });
            return { consumed: true, submenu: factory };
          }
        }
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/inline-edit.ts
import { matchesKey as matchesKey6, decodeKittyPrintable } from "@earendil-works/pi-tui";
function inlineEditChars(text) {
  const out = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    out.push({ ch: segment, start: index, end: index + segment.length });
  }
  return out;
}
function clampInlineCursor(editing) {
  editing.cursor = Math.max(0, Math.min(editing.cursor, editing.buffer.length));
}
function codeUnitToCharIndex(chars, cursor) {
  let index = 0;
  while (index < chars.length && chars[index].end <= cursor) index += 1;
  return index;
}
function charIndexToCodeUnit(chars, index, textLength) {
  if (index <= 0) return 0;
  if (index >= chars.length) return textLength;
  return chars[index].start;
}
function inlineCharKind(ch) {
  if (/\s/u.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}
function moveInlineCursorByChars(editing, delta) {
  const chars = inlineEditChars(editing.buffer);
  const index = codeUnitToCharIndex(chars, editing.cursor);
  editing.cursor = charIndexToCodeUnit(chars, index + delta, editing.buffer.length);
}
function moveInlineCursorWordLeft(editing) {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index > 0 && inlineCharKind(chars[index - 1].ch) === "space") index -= 1;
  if (index <= 0) {
    editing.cursor = 0;
    return;
  }
  const kind2 = inlineCharKind(chars[index - 1].ch);
  while (index > 0 && inlineCharKind(chars[index - 1].ch) === kind2) index -= 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}
function moveInlineCursorWordRight(editing) {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index < chars.length && inlineCharKind(chars[index].ch) === "space") index += 1;
  if (index >= chars.length) {
    editing.cursor = editing.buffer.length;
    return;
  }
  const kind2 = inlineCharKind(chars[index].ch);
  while (index < chars.length && inlineCharKind(chars[index].ch) === kind2) index += 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}
function insertInlineText(editing, text) {
  clampInlineCursor(editing);
  editing.buffer = `${editing.buffer.slice(0, editing.cursor)}${text}${editing.buffer.slice(editing.cursor)}`;
  editing.cursor += text.length;
}
function deleteInlineRange(editing, start, end) {
  const safeStart = Math.max(0, Math.min(start, editing.buffer.length));
  const safeEnd = Math.max(safeStart, Math.min(end, editing.buffer.length));
  editing.buffer = `${editing.buffer.slice(0, safeStart)}${editing.buffer.slice(safeEnd)}`;
  editing.cursor = safeStart;
}
function isPlainSearchInput(data) {
  const decoded = decodeKittyPrintable(data) ?? data;
  return decoded.length === 1 && decoded >= " " && decoded !== "\x7F";
}
function handleInlineEditInput(editing, data) {
  clampInlineCursor(editing);
  if (matchesKey6(data, "left") || matchesKey6(data, "ctrl+b")) {
    moveInlineCursorByChars(editing, -1);
    return true;
  }
  if (matchesKey6(data, "right") || matchesKey6(data, "ctrl+f")) {
    moveInlineCursorByChars(editing, 1);
    return true;
  }
  if (matchesKey6(data, "alt+left") || matchesKey6(data, "ctrl+left") || matchesKey6(data, "alt+b")) {
    moveInlineCursorWordLeft(editing);
    return true;
  }
  if (matchesKey6(data, "alt+right") || matchesKey6(data, "ctrl+right") || matchesKey6(data, "alt+f")) {
    moveInlineCursorWordRight(editing);
    return true;
  }
  if (matchesKey6(data, "home") || matchesKey6(data, "ctrl+a")) {
    editing.cursor = 0;
    return true;
  }
  if (matchesKey6(data, "end") || matchesKey6(data, "ctrl+e")) {
    editing.cursor = editing.buffer.length;
    return true;
  }
  if (matchesKey6(data, "backspace") || matchesKey6(data, "ctrl+h")) {
    const before = editing.cursor;
    moveInlineCursorByChars(editing, -1);
    deleteInlineRange(editing, editing.cursor, before);
    return true;
  }
  if (matchesKey6(data, "delete")) {
    const start = editing.cursor;
    moveInlineCursorByChars(editing, 1);
    deleteInlineRange(editing, start, editing.cursor);
    return true;
  }
  if (matchesKey6(data, "ctrl+u")) {
    editing.buffer = "";
    editing.cursor = 0;
    return true;
  }
  if (matchesKey6(data, "ctrl+w")) {
    const current = editing.cursor;
    moveInlineCursorWordLeft(editing);
    const target = editing.cursor;
    const killedText = editing.buffer.slice(target, current);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, target, current);
    return true;
  }
  if (matchesKey6(data, "alt+d")) {
    const current = editing.cursor;
    moveInlineCursorWordRight(editing);
    const target = editing.cursor;
    const killedText = editing.buffer.slice(current, target);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, current, target);
    return true;
  }
  if (matchesKey6(data, "ctrl+k")) {
    const killedText = editing.buffer.slice(editing.cursor);
    if (killedText) {
      yankBuffer = killedText;
    }
    deleteInlineRange(editing, editing.cursor, editing.buffer.length);
    return true;
  }
  if (matchesKey6(data, "ctrl+y")) {
    if (yankBuffer) {
      insertInlineText(editing, yankBuffer);
    }
    return true;
  }
  if (isPlainSearchInput(data)) {
    const decoded = decodeKittyPrintable(data) ?? data;
    insertInlineText(editing, decoded);
    return true;
  }
  return false;
}
function renderInlineEditValue(editing) {
  clampInlineCursor(editing);
  return `${editing.buffer.slice(0, editing.cursor)}\u2588${editing.buffer.slice(editing.cursor)}`;
}
function deleteWordBackward(text) {
  let i = text.length;
  while (i > 0 && /\s/.test(text[i - 1])) {
    i--;
  }
  if (i === 0) return "";
  const charKind = (ch) => {
    if (/\s/.test(ch)) return "space";
    if (/[A-Za-z0-9_]/.test(ch)) return "word";
    return "punct";
  };
  const kind2 = charKind(text[i - 1]);
  while (i > 0 && charKind(text[i - 1]) === kind2) {
    i--;
  }
  return text.slice(0, i);
}
var GRAPHEME_SEGMENTER, yankBuffer;
var init_inline_edit = __esm({
  "modules/blackhole/src/pi-base/settings/inline-edit.ts"() {
    "use strict";
    GRAPHEME_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
    yankBuffer = "";
  }
});

// modules/blackhole/src/pi-base/settings/fields/enum.ts
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey as matchesKey7,
  SelectList,
  truncateToWidth as truncateToWidth2
} from "@earendil-works/pi-tui";
function labelFor(field, value) {
  return field.optionLabels?.[value] ?? value;
}
function nextCycleValue(field, current) {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current);
  const nextIdx = (idx + 1 + field.options.length) % field.options.length;
  return field.options[nextIdx];
}
function prevCycleValue(field, current) {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current);
  const prevIdx = (idx - 1 + field.options.length) % field.options.length;
  return field.options[prevIdx];
}
function makeEnumSubmenu(field, current, ctx) {
  if (field.search) {
    return makeSearchableEnumSubmenu(field, current, ctx);
  }
  return (done) => {
    const items = field.options.map((value, idx2) => {
      const isActive = value === current;
      const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "\u2714")}` : "";
      return {
        value,
        label: `${idx2 + 1}. ${labelFor(field, value)}${activeSuffix}`
      };
    });
    const list = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_ROWS),
      getSelectListTheme()
    );
    const idx = field.options.indexOf(current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();
    const component = {
      render(width) {
        const lines = [...list.render(width)];
        lines.push("");
        const hints = [
          { key: "\u2191\u2193", label: "select" },
          ...items.length > 1 ? [{ key: `1-${Math.min(9, items.length)}`, label: "choose" }] : [],
          { key: "enter/space", label: "save" },
          ...field.default !== void 0 ? [{ key: "alt+r", label: "reset" }] : [],
          { key: "esc", label: "cancel" }
        ];
        const hintText = `  ${formatHintLine(hints, ctx.theme)}`;
        lines.push(truncateToWidth2(hintText, width, "\u2026", true));
        return lines;
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (matchesKey7(data, "alt+r") && field.default !== void 0) {
          const defaultIdx = field.options.indexOf(field.default);
          if (defaultIdx >= 0) {
            list.setSelectedIndex(defaultIdx);
            ctx.tui.requestRender();
          }
          return;
        }
        if (data === " ") {
          const item = list.getSelectedItem();
          if (item) {
            done(item.value);
            return;
          }
        }
        const num = parseInt(data, 10);
        if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
          const item = items[num - 1];
          if (item) {
            done(item.value);
            return;
          }
        }
        list.handleInput(data);
        ctx.tui.requestRender();
      }
    };
    return component;
  };
}
function makeSearchableEnumSubmenu(field, current, ctx) {
  return (done) => {
    const allItems = field.options.map((value) => ({
      value,
      label: labelFor(field, value)
    }));
    let search = "";
    let selected = 0;
    function filteredItems() {
      if (!search.trim()) {
        return allItems.map((item, idx) => ({
          ...item,
          label: `${idx + 1}. ${item.label}`
        }));
      }
      const q = search.toLowerCase();
      return allItems.filter(
        (item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)
      );
    }
    function clampSelected() {
      const items = filteredItems();
      if (selected >= items.length) selected = Math.max(0, items.length - 1);
    }
    const component = {
      render(width) {
        const lines = [];
        const items = filteredItems();
        const cursor = ctx.theme.inverse(" ");
        const hasMatches = items.length > 0;
        let searchPrompt;
        if (!search) {
          searchPrompt = `Search: ${cursor}${ctx.theme.fg("muted", "type to filter\u2026")}`;
        } else {
          const queryColor = hasMatches ? "accent" : "warning";
          searchPrompt = `Search: ${ctx.theme.fg(queryColor, search)}${cursor}`;
        }
        lines.push(ctx.theme.bg("toolPendingBg", truncateToWidth2(searchPrompt, width, "\u2026", true)));
        lines.push("");
        if (items.length === 0) {
          if (search) {
            const prefix = ctx.theme.fg("muted", "  No matching options for '");
            const q = ctx.theme.fg("warning", search);
            const suffix = ctx.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
            lines.push(`${prefix}${q}${suffix}`);
          } else {
            lines.push(ctx.theme.fg("muted", "  No options available. (press esc to cancel)"));
          }
        } else {
          const maxVisible = MAX_VISIBLE_ROWS;
          const scroll = Math.max(
            0,
            Math.min(selected - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible))
          );
          const slice = items.slice(scroll, scroll + maxVisible);
          for (let i = 0; i < slice.length; i++) {
            const isSelected = scroll + i === selected;
            const prefix = isSelected ? ctx.theme.fg("accent", "\u258C ") : "  ";
            const item = slice[i];
            const isActive = item.value === current;
            const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "\u2714")}` : "";
            const display = isSelected ? ctx.theme.fg("accent", item.label) : ctx.theme.fg("muted", item.label);
            const line = `${prefix}${display}${activeSuffix}`;
            lines.push(
              isSelected ? ctx.theme.bg("selectedBg", truncateToWidth2(line, width, "\u2026", true)) : truncateToWidth2(line, width, "\u2026", true)
            );
          }
        }
        lines.push("");
        const hints = [{ key: "\u2191\u2193", label: "select" }];
        if (!search && items.length > 1) {
          hints.push({ key: `1-${Math.min(9, items.length)}`, label: "choose" });
        }
        hints.push({ key: "enter", label: "save" });
        if (field.default !== void 0) {
          hints.push({ key: "alt+r", label: "reset" });
        }
        if (search) {
          hints.push({ key: "ctrl+w", label: "delete word" });
          hints.push({ key: "ctrl+u", label: "clear" });
          hints.push({ key: "esc", label: "clear filter" });
        } else {
          hints.push({ key: "esc", label: "cancel" });
        }
        const hintText = formatHintLine(hints, ctx.theme);
        lines.push(`  ${truncateToWidth2(hintText, width, "\u2026", true)}`);
        return lines;
      },
      invalidate() {
      },
      handleInput(data) {
        const items = filteredItems();
        if (matchesKey7(data, "alt+r") && field.default !== void 0) {
          search = "";
          const newItems = filteredItems();
          const defaultIdx = newItems.findIndex((item) => item.value === field.default);
          if (defaultIdx >= 0) {
            selected = defaultIdx;
          }
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "home")) {
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "end")) {
          selected = Math.max(0, items.length - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "pageUp")) {
          selected = Math.max(0, selected - MAX_VISIBLE_ROWS);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "pageDown")) {
          selected = Math.min(Math.max(0, items.length - 1), selected + MAX_VISIBLE_ROWS);
          ctx.tui.requestRender();
          return;
        }
        if (!search.trim()) {
          const num = parseInt(data, 10);
          if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
            const item = items[num - 1];
            if (item) {
              done(item.value);
              return;
            }
          }
        }
        if (matchesKey7(data, "up")) {
          selected = Math.max(0, selected - 1);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "down")) {
          selected = Math.min(selected + 1, Math.max(0, items.length - 1));
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "enter") || matchesKey7(data, "return")) {
          if (items.length > 0) {
            done(items[Math.min(selected, items.length - 1)].value);
          }
          return;
        }
        if (matchesKey7(data, "escape")) {
          if (search !== "") {
            const selectedValue = items[selected]?.value;
            search = "";
            const newItems = filteredItems();
            const newIndex = selectedValue ? newItems.findIndex((item) => item.value === selectedValue) : -1;
            selected = newIndex >= 0 ? newIndex : 0;
            ctx.tui.requestRender();
          } else {
            done();
          }
          return;
        }
        if (matchesKey7(data, "ctrl+u")) {
          search = "";
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "ctrl+w")) {
          search = deleteWordBackward(search);
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey7(data, "backspace") || matchesKey7(data, "ctrl+h")) {
          search = search.slice(0, -1);
          selected = 0;
          ctx.tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " " && data !== "\x7F") {
          search += data;
          selected = 0;
          ctx.tui.requestRender();
        }
      }
    };
    return component;
  };
}
var DEFAULT_CYCLE_THRESHOLD, MAX_VISIBLE_ROWS, enumRenderer;
var init_enum = __esm({
  "modules/blackhole/src/pi-base/settings/fields/enum.ts"() {
    "use strict";
    init_frame();
    init_inline_edit();
    DEFAULT_CYCLE_THRESHOLD = 4;
    MAX_VISIBLE_ROWS = 12;
    enumRenderer = {
      type: "enum",
      renderValue(row, { selected, ctx }) {
        const text = labelFor(row.field, row.value);
        if (row.field.disabled) {
          const desc2 = row.field.valueDescriptions?.[row.value];
          const suffix2 = desc2 ? ` (${desc2})` : "";
          return ctx.theme.fg("muted", text + suffix2);
        }
        const desc = row.field.valueDescriptions?.[row.value];
        const suffix = desc ? ` ${ctx.theme.fg("dim", `(${desc})`)}` : "";
        return ctx.theme.fg(selected ? "accent" : "muted", text) + suffix;
      },
      hints(row) {
        if (row.field.disabled) return [];
        if (row.field.search) {
          return [{ key: "enter/space", label: "open list" }];
        }
        const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
        if (row.field.options.length > threshold) {
          return [{ key: "enter/space", label: "open list" }];
        }
        return [
          { key: "enter/space", label: "cycle" },
          { key: "\u2190/\u2192", label: "prev/next" }
        ];
      },
      handleKey(row, data, { ctx }) {
        if (row.field.disabled) return {};
        if (row.field.search) {
          if (matchesKey7(data, "enter") || matchesKey7(data, "return") || data === " ") {
            return {
              consumed: true,
              submenu: makeEnumSubmenu(row.field, row.value, ctx)
            };
          }
          return {};
        }
        const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
        const isLongList = row.field.options.length > threshold;
        if (matchesKey7(data, "enter") || matchesKey7(data, "return") || data === " ") {
          if (isLongList) {
            return {
              consumed: true,
              submenu: makeEnumSubmenu(row.field, row.value, ctx)
            };
          }
          return { consumed: true, commit: nextCycleValue(row.field, row.value) };
        }
        if (!isLongList) {
          if (matchesKey7(data, "left")) {
            const prev = prevCycleValue(row.field, row.value);
            if (prev === row.value) return { consumed: true };
            return { consumed: true, commit: prev };
          }
          if (matchesKey7(data, "right")) {
            const next = nextCycleValue(row.field, row.value);
            if (next === row.value) return { consumed: true };
            return { consumed: true, commit: next };
          }
        }
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/model.ts
import { getSelectListTheme as getSelectListTheme2 } from "@earendil-works/pi-coding-agent";
import {
  matchesKey as matchesKey8,
  SelectList as SelectList2,
  truncateToWidth as truncateToWidth3
} from "@earendil-works/pi-tui";
function effortDisplayLabel(level, thinkingLevelMap) {
  const mapped = thinkingLevelMap?.[level];
  if (typeof mapped === "string" && mapped.length > 0) return mapped;
  return LEVEL_FALLBACK_LABELS[level] ?? level;
}
function listModelOptions(field, ctx) {
  if (field.models) return field.models;
  const sessionLabel = field.sessionLabel ?? DEFAULT_SESSION_LABEL;
  const available = ctx.ctx.modelRegistry.getAvailable();
  const filtered = field.filter ? available.filter(field.filter) : available;
  const live = filtered.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.name}  [${m.provider}]`,
    model: m
  }));
  return field.hideSession ? live : [{ value: "", label: sessionLabel }, ...live];
}
function resolveModelForValue(field, value, ctx) {
  if (!value.id) return void 0;
  if (field.models) {
    const opt = field.models.find((o) => o.value === value.id);
    if (opt?.model) return opt.model;
  }
  const slash = value.id.indexOf("/");
  if (slash <= 0) return void 0;
  const provider = value.id.slice(0, slash);
  const id = value.id.slice(slash + 1);
  return ctx.ctx.modelRegistry.find(provider, id);
}
function supportedEfforts(model) {
  if (!model || !model.thinkingLevelMap) return ALL_THINKING_LEVELS;
  const map = model.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((lvl) => !(lvl in map && map[lvl] === null));
}
function clampEffort(desired, supported) {
  if (desired && supported.includes(desired)) return desired;
  return supported.includes("medium") ? "medium" : supported[0] ?? "off";
}
function modelDisplay(field, value) {
  if (value.id === "") return field.sessionLabel ?? DEFAULT_SESSION_LABEL;
  return value.id;
}
function rowLabel(field, value, ctx) {
  const left = modelDisplay(field, value);
  if (field.hideEffort) return left;
  if (!value.thinking) return left;
  const model = resolveModelForValue(field, value, ctx);
  const label = effortDisplayLabel(value.thinking, model?.thinkingLevelMap);
  return `${left}  \xB7  ${label}`;
}
function makeSubmenu(field, current, ctx) {
  return (done) => {
    const allOptions = listModelOptions(field, ctx);
    const showEffort = !field.hideEffort;
    const filter = { buffer: "", cursor: 0 };
    let list;
    let visibleOptions = [];
    let effortIndex = 0;
    let supported = [];
    const refreshEffort = (preferred) => {
      if (!showEffort) return;
      const item = list.getSelectedItem();
      const opt = visibleOptions.find((m) => m.value === item?.value);
      supported = supportedEfforts(opt?.model);
      if (supported.length === 0) supported = ["off"];
      const clamped = clampEffort(preferred, supported);
      effortIndex = Math.max(0, supported.indexOf(clamped));
    };
    const buildList = (preserveValue) => {
      const query = filter.buffer.trim().toLowerCase();
      visibleOptions = query ? allOptions.filter(
        (o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query)
      ) : allOptions;
      const items = visibleOptions.map((m, idx2) => ({
        value: m.value,
        label: !query ? `${idx2 + 1}. ${m.label}` : m.label,
        description: m.value || void 0
      }));
      list = new SelectList2(
        items,
        Math.min(Math.max(items.length, 1), MAX_VISIBLE_MODELS),
        getSelectListTheme2()
      );
      const idx = preserveValue !== void 0 ? items.findIndex((i) => i.value === preserveValue) : -1;
      list.setSelectedIndex(idx >= 0 ? idx : 0);
      list.onSelect = (item) => {
        if (showEffort) {
          refreshEffort(supported[effortIndex]);
          const effort = supported[effortIndex] ?? "off";
          done({ id: item.value, thinking: effort });
        } else {
          done({ id: item.value });
        }
      };
      list.onCancel = () => done();
      list.onSelectionChange = () => {
        if (showEffort) {
          const previous = supported[effortIndex];
          refreshEffort(previous);
        }
        ctx.tui.requestRender();
      };
    };
    buildList(current.id);
    refreshEffort(current.thinking);
    const renderEffortRow = (width) => {
      const currentLevel = supported[effortIndex] ?? "off";
      const item = list.getSelectedItem();
      const opt = visibleOptions.find((m) => m.value === item?.value);
      const displayLabel = effortDisplayLabel(currentLevel, opt?.model?.thinkingLevelMap);
      const left = effortIndex > 0 ? ctx.theme.fg("accent", "\u2039") : ctx.theme.fg("dim", "\u2039");
      const right = effortIndex < supported.length - 1 ? ctx.theme.fg("accent", "\u203A") : ctx.theme.fg("dim", "\u203A");
      const label = ctx.theme.fg("muted", "  effort: ");
      const valueText = displayLabel === currentLevel ? displayLabel : `${displayLabel} ${ctx.theme.fg("dim", `(${currentLevel})`)}`;
      const value = ctx.theme.fg("accent", ctx.theme.bold(valueText));
      const counter = ctx.theme.fg("dim", `  (${effortIndex + 1}/${supported.length})`);
      return truncateToWidth3(`${label}${left} ${value} ${right}${counter}`, width, "\u2026", true);
    };
    const renderFilterRow = (width) => {
      const cursorBlock = ctx.theme.inverse(" ");
      const buf = filter.buffer;
      const before = buf.slice(0, filter.cursor);
      const after = buf.slice(filter.cursor);
      const placeholder = !buf ? ctx.theme.fg("dim", "  filter models\u2026") : "";
      const hasMatches = visibleOptions.length > 0;
      const colorKey = hasMatches ? "accent" : "warning";
      const text = buf ? `  ${ctx.theme.fg("muted", "filter:")} ${ctx.theme.fg(colorKey, before)}${cursorBlock}${ctx.theme.fg(colorKey, after)}` : `  ${ctx.theme.fg("muted", "filter:")} ${cursorBlock}${placeholder}`;
      return truncateToWidth3(text, width, "\u2026", true);
    };
    const renderHints = (width) => {
      const hints = [{ key: "\u2191\u2193", label: "model" }];
      if (showEffort) hints.push({ key: "\u2190\u2192", label: "effort" });
      if (!filter.buffer && visibleOptions.length > 1) {
        hints.push({ key: `1-${Math.min(9, visibleOptions.length)}`, label: "choose" });
      }
      hints.push({ key: "type", label: "filter" });
      if (field.default !== void 0) {
        hints.push({ key: "alt+r", label: "reset" });
      }
      hints.push({ key: "enter", label: "save" });
      if (filter.buffer !== "") {
        hints.push({ key: "ctrl+w", label: "delete word" });
        hints.push({ key: "ctrl+u", label: "clear" });
        hints.push({ key: "esc", label: "clear filter" });
      } else {
        hints.push({ key: "esc", label: "cancel" });
      }
      return truncateToWidth3(`  ${formatHintLine(hints, ctx.theme)}`, width, "\u2026", true);
    };
    return {
      render(width) {
        const lines = [];
        lines.push(renderFilterRow(width));
        lines.push("");
        if (visibleOptions.length === 0) {
          if (filter.buffer) {
            const prefix = ctx.theme.fg("muted", "  No matching models for '");
            const q = ctx.theme.fg("warning", filter.buffer);
            const suffix = ctx.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
            lines.push(`${prefix}${q}${suffix}`);
          } else {
            lines.push(ctx.theme.fg("muted", "  No models available. (press esc to cancel)"));
          }
        } else {
          for (const line of list.render(width)) lines.push(line);
        }
        lines.push("");
        if (showEffort) {
          lines.push(renderEffortRow(width));
          lines.push("");
        }
        lines.push(renderHints(width));
        return lines;
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (matchesKey8(data, "alt+r") && field.default !== void 0) {
          filter.buffer = "";
          filter.cursor = 0;
          buildList(field.default.id);
          refreshEffort(field.default.thinking);
          ctx.tui.requestRender();
          return;
        }
        if (!filter.buffer) {
          const num = parseInt(data, 10);
          if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, visibleOptions.length)) {
            const item = visibleOptions[num - 1];
            if (item) {
              if (showEffort) {
                const idx = visibleOptions.findIndex((m) => m.value === item.value);
                if (idx >= 0) list.setSelectedIndex(idx);
                refreshEffort(supported[effortIndex]);
                const effort = supported[effortIndex] ?? "off";
                done({ id: item.value, thinking: effort });
              } else {
                done({ id: item.value });
              }
              return;
            }
          }
        }
        if (showEffort) {
          if (matchesKey8(data, "left")) {
            if (effortIndex > 0) {
              effortIndex -= 1;
              ctx.tui.requestRender();
            }
            return;
          }
          if (matchesKey8(data, "right")) {
            if (effortIndex < supported.length - 1) {
              effortIndex += 1;
              ctx.tui.requestRender();
            }
            return;
          }
        }
        if (matchesKey8(data, "escape") && filter.buffer !== "") {
          const previousValue2 = list.getSelectedItem()?.value;
          filter.buffer = "";
          filter.cursor = 0;
          buildList(previousValue2);
          refreshEffort(supported[effortIndex]);
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey8(data, "up") || matchesKey8(data, "down") || matchesKey8(data, "enter") || matchesKey8(data, "return") || matchesKey8(data, "escape") || matchesKey8(data, "ctrl+c")) {
          list.handleInput(data);
          ctx.tui.requestRender();
          return;
        }
        const previousValue = list.getSelectedItem()?.value;
        const consumed = handleInlineEditInput(filter, data);
        if (consumed) {
          buildList(previousValue);
          refreshEffort(supported[effortIndex]);
          ctx.tui.requestRender();
        }
      }
    };
  };
}
var ALL_THINKING_LEVELS, LEVEL_FALLBACK_LABELS, DEFAULT_SESSION_LABEL, MAX_VISIBLE_MODELS, modelRenderer;
var init_model = __esm({
  "modules/blackhole/src/pi-base/settings/fields/model.ts"() {
    "use strict";
    init_frame();
    init_inline_edit();
    ALL_THINKING_LEVELS = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ];
    LEVEL_FALLBACK_LABELS = {
      off: "off",
      minimal: "min",
      low: "low",
      medium: "med",
      high: "high",
      xhigh: "xhigh",
      max: "max"
    };
    DEFAULT_SESSION_LABEL = "(session model)";
    MAX_VISIBLE_MODELS = 12;
    modelRenderer = {
      type: "model",
      renderValue(row, { selected, ctx }) {
        const text = rowLabel(row.field, row.value, ctx);
        if (row.field.disabled) {
          return ctx.theme.fg("muted", text);
        }
        return ctx.theme.fg(selected ? "accent" : "muted", text);
      },
      hints(row) {
        if (row.field.disabled) return [];
        return [{ key: "enter/space", label: "open" }];
      },
      handleKey(row, data, { ctx }) {
        if (row.field.disabled) return {};
        if (matchesKey8(data, "enter") || matchesKey8(data, "return") || data === " ") {
          return { consumed: true, submenu: makeSubmenu(row.field, row.value, ctx) };
        }
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/string.ts
import {
  matchesKey as matchesKey9,
  truncateToWidth as truncateToWidth4
} from "@earendil-works/pi-tui";
import { SelectList as SelectList3 } from "@earendil-works/pi-tui";
import { getSelectListTheme as getSelectListTheme3 } from "@earendil-works/pi-coding-agent";
function getEditState(args, key2) {
  const registry = args.ctx.editStates;
  return registry?.get(key2);
}
function setEditState(args, key2, state) {
  const registry = args.ctx.editStates;
  if (!registry) return;
  if (state === void 0) registry.delete(key2);
  else registry.set(key2, state);
}
function maskedSecret(value) {
  if (!value) return "(unset)";
  return "\u2022\u2022\u2022\u2022\u2022\u2022";
}
function placeholderOrEmpty(field, value, dim) {
  if (value) return value;
  const placeholder = field.placeholder;
  if (placeholder) return dim(placeholder);
  return dim("(unset)");
}
function nextValue(values, current) {
  if (values.length === 0) return current;
  const idx = values.indexOf(current);
  return values[(idx + 1 + values.length) % values.length];
}
function prevValue(values, current) {
  if (values.length === 0) return current;
  const idx = values.indexOf(current);
  return values[(idx - 1 + values.length) % values.length];
}
function stepUp(value, step, min, max) {
  const next = value + step;
  if (max !== void 0 && next > max) return min ?? value;
  return next;
}
function stepDown(value, step, min, max) {
  const prev = value - step;
  if (min !== void 0 && prev < min) return max ?? value;
  return prev;
}
function getValueDesc(field) {
  return field.valueDescriptions?.[String(field.value)];
}
function makeNumberValuesSubmenu(field, current, _valueDesc, ctx) {
  const values = field.values ?? [];
  return (done) => {
    const items = values.map((v, idx2) => {
      const isActive = v === current;
      const activeSuffix = isActive ? `  ${ctx.theme.fg("success", "\u2714")}` : "";
      return {
        value: String(v),
        label: `${idx2 + 1}. ${v}${activeSuffix}`
      };
    });
    const list = new SelectList3(items, Math.min(items.length, 12), getSelectListTheme3());
    const idx = items.findIndex((i) => Number(i.value) === current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(Number(item.value));
    list.onCancel = () => done();
    const component = {
      render(width) {
        const lines = [...list.render(width)];
        lines.push("");
        const hints = [
          { key: "\u2191\u2193", label: "select" },
          ...items.length > 1 ? [{ key: `1-${Math.min(9, items.length)}`, label: "choose" }] : [],
          { key: "enter/space", label: "save" },
          ...field.default !== void 0 ? [{ key: "alt+r", label: "reset" }] : [],
          { key: "esc", label: "cancel" }
        ];
        const hintText = `  ${formatHintLine(hints, ctx.theme)}`;
        lines.push(truncateToWidth4(hintText, width, "\u2026", true));
        return lines;
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (matchesKey9(data, "alt+r") && field.default !== void 0) {
          const defaultIdx = values.indexOf(field.default);
          if (defaultIdx >= 0) {
            list.setSelectedIndex(defaultIdx);
            ctx.tui.requestRender();
          }
          return;
        }
        if (data === " ") {
          const item = list.getSelectedItem();
          if (item) {
            done(Number(item.value));
            return;
          }
        }
        const num = parseInt(data, 10);
        if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
          const item = items[num - 1];
          if (item) {
            done(Number(item.value));
            return;
          }
        }
        list.handleInput(data);
        ctx.tui.requestRender();
      }
    };
    return component;
  };
}
function handleStringLikeKey(key2, initialBuffer, data, args, parse, defaultValue) {
  const initialStr = String(initialBuffer);
  if (!args.isEditing) {
    if (matchesKey9(data, "enter") || matchesKey9(data, "return")) {
      setEditState(args, key2, { buffer: initialStr, cursor: initialStr.length });
      args.setEditing(true);
      return { consumed: true };
    }
    return {};
  }
  if (matchesKey9(data, "alt+r") && defaultValue !== void 0) {
    const defaultStr = String(defaultValue);
    setEditState(args, key2, { buffer: defaultStr, cursor: defaultStr.length });
    return { consumed: true };
  }
  if (matchesKey9(data, "enter") || matchesKey9(data, "return")) {
    const state2 = getEditState(args, key2);
    if (!state2) {
      args.setEditing(false);
      return { consumed: true };
    }
    try {
      const value = parse(state2.buffer);
      setEditState(args, key2, void 0);
      args.setEditing(false);
      return { consumed: true, commit: value };
    } catch (error) {
      throw error;
    }
  }
  if (matchesKey9(data, "escape")) {
    setEditState(args, key2, void 0);
    args.setEditing(false);
    return { consumed: true };
  }
  const state = getEditState(args, key2);
  if (!state) {
    setEditState(args, key2, { buffer: initialStr, cursor: initialStr.length });
    return { consumed: true };
  }
  if (handleInlineEditInput(state, data)) {
    return { consumed: true };
  }
  return { consumed: true };
}
var stringRenderer, pathRenderer, secretRenderer, numberRenderer;
var init_string = __esm({
  "modules/blackhole/src/pi-base/settings/fields/string.ts"() {
    "use strict";
    init_inline_edit();
    init_frame();
    stringRenderer = {
      type: "string",
      renderValue(row, args) {
        const dim = (s) => args.ctx.theme.fg("dim", s);
        if (row.field.disabled) {
          const text2 = placeholderOrEmpty(row.field, row.value, dim);
          return args.ctx.theme.fg("muted", text2);
        }
        if (args.isEditing) {
          const state = getEditState(args, row.field.key);
          if (state) {
            return args.ctx.theme.fg("accent", renderInlineEditValue(state));
          }
        }
        const text = placeholderOrEmpty(row.field, row.value, dim);
        return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
      },
      hints(row, { isEditing }) {
        if (row.field.disabled) return [];
        if (isEditing) {
          const hints = [
            { key: "enter", label: "save" },
            { key: "esc", label: "cancel" },
            { key: "\u2190/\u2192", label: "move" },
            { key: "ctrl+w", label: "delete word" },
            { key: "ctrl+u", label: "clear" }
          ];
          if (row.field.default !== void 0) {
            hints.push({ key: "alt+r", label: "reset" });
          }
          return hints;
        }
        return [{ key: "enter", label: "edit" }];
      },
      handleKey(row, data, args) {
        if (row.field.disabled) return {};
        return handleStringLikeKey(
          row.field.key,
          row.value,
          data,
          args,
          (buf) => buf,
          row.field.default
        );
      }
    };
    pathRenderer = {
      type: "path",
      renderValue(row, args) {
        return stringRenderer.renderValue(row, args);
      },
      hints(row, args) {
        return stringRenderer.hints(
          row,
          args
        );
      },
      handleKey(row, data, args) {
        if (row.field.disabled) return {};
        return handleStringLikeKey(
          row.field.key,
          row.value,
          data,
          args,
          (buf) => buf,
          row.field.default
        );
      }
    };
    secretRenderer = {
      type: "secret",
      renderValue(row, args) {
        if (row.field.disabled) {
          const display2 = maskedSecret(row.value);
          return args.ctx.theme.fg("muted", display2);
        }
        if (args.isEditing) {
          const state = getEditState(args, row.field.key);
          if (state) {
            const masked = "\u2022".repeat(state.buffer.length);
            const view = {
              buffer: masked,
              cursor: state.cursor
            };
            return args.ctx.theme.fg("accent", renderInlineEditValue(view));
          }
        }
        const display = maskedSecret(row.value);
        return args.selected ? args.ctx.theme.fg("text", display) : args.ctx.theme.fg(row.value ? "success" : "muted", display);
      },
      hints(row, args) {
        return stringRenderer.hints(
          row,
          args
        );
      },
      handleKey(row, data, args) {
        if (row.field.disabled) return {};
        return handleStringLikeKey(
          row.field.key,
          row.value,
          data,
          args,
          (buf) => buf,
          row.field.default
        );
      }
    };
    numberRenderer = {
      type: "number",
      renderValue(row, args) {
        if (row.field.disabled) {
          const text2 = String(row.value);
          return args.ctx.theme.fg("muted", text2);
        }
        if (args.isEditing) {
          const state = getEditState(args, row.field.key);
          if (state) {
            return args.ctx.theme.fg("accent", renderInlineEditValue(state));
          }
        }
        const text = String(row.value);
        return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
      },
      hints(row, args) {
        if (row.field.disabled) return [];
        if (args.isEditing) {
          return [
            { key: "enter", label: "save" },
            { key: "esc", label: "cancel" },
            { key: "\u2190/\u2192", label: "move" },
            { key: "ctrl+w", label: "delete word" },
            { key: "ctrl+u", label: "clear" },
            ...row.field.default !== void 0 ? [{ key: "alt+r", label: "reset" }] : []
          ];
        }
        const { values, step } = row.field;
        if (values && values.length > 4) return [{ key: "enter", label: "open list" }];
        if (values && values.length > 0) {
          return [
            { key: "enter/space", label: "cycle" },
            { key: "\u2190/\u2192", label: "prev/next" }
          ];
        }
        if (step !== void 0) {
          return [
            { key: "enter/space", label: "edit" },
            { key: "\u2190/\u2192", label: "step" }
          ];
        }
        return stringRenderer.hints(
          row,
          args
        );
      },
      handleKey(row, data, args) {
        if (row.field.disabled) return {};
        const { values, step } = row.field;
        if (values && values.length > 0) {
          if (matchesKey9(data, "enter") || matchesKey9(data, "return") || data === " ") {
            if (values.length > 4) {
              return {
                consumed: true,
                submenu: makeNumberValuesSubmenu(
                  row.field,
                  row.value,
                  getValueDesc(row.field),
                  args.ctx
                )
              };
            }
            return { consumed: true, commit: nextValue(values, row.value) };
          }
          if (matchesKey9(data, "left")) {
            return { consumed: true, commit: prevValue(values, row.value) };
          }
          if (matchesKey9(data, "right")) {
            return { consumed: true, commit: nextValue(values, row.value) };
          }
          return {};
        }
        if (step !== void 0) {
          if (!args.isEditing) {
            if (matchesKey9(data, "left")) {
              return {
                consumed: true,
                commit: stepDown(row.value, step, row.field.min, row.field.max)
              };
            }
            if (matchesKey9(data, "right")) {
              return {
                consumed: true,
                commit: stepUp(row.value, step, row.field.min, row.field.max)
              };
            }
          }
          return handleStringLikeKey(
            row.field.key,
            String(row.value),
            data,
            args,
            (buffer2) => {
              const trimmed = buffer2.trim();
              if (trimmed === "") throw new Error("Expected a number");
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer2}'`);
              if (row.field.integer && !Number.isInteger(parsed))
                throw new Error("Expected an integer");
              if (typeof row.field.min === "number" && parsed < row.field.min)
                throw new Error(`Must be \u2265 ${row.field.min}`);
              if (typeof row.field.max === "number" && parsed > row.field.max)
                throw new Error(`Must be \u2264 ${row.field.max}`);
              return parsed;
            },
            row.field.default
          );
        }
        return handleStringLikeKey(
          row.field.key,
          String(row.value),
          data,
          args,
          (buffer2) => {
            const trimmed = buffer2.trim();
            if (trimmed === "") throw new Error("Expected a number");
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer2}'`);
            if (row.field.integer && !Number.isInteger(parsed)) throw new Error("Expected an integer");
            if (typeof row.field.min === "number" && parsed < row.field.min)
              throw new Error(`Must be \u2265 ${row.field.min}`);
            if (typeof row.field.max === "number" && parsed > row.field.max)
              throw new Error(`Must be \u2264 ${row.field.max}`);
            if (values && !values.includes(parsed))
              throw new Error(`Must be one of: ${values.join(", ")}`);
            return parsed;
          },
          row.field.default
        );
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/readonly.ts
var readonlyRenderer;
var init_readonly = __esm({
  "modules/blackhole/src/pi-base/settings/fields/readonly.ts"() {
    "use strict";
    readonlyRenderer = {
      type: "readonly",
      renderValue(row, args) {
        const value = row.value;
        if (row.field.disabled) {
          return args.ctx.theme.fg("muted", value);
        }
        if (row.field.emphasis) {
          return args.ctx.theme.fg("accent", value);
        }
        return args.selected ? args.ctx.theme.fg("text", value) : args.ctx.theme.fg("muted", value);
      },
      hints(row) {
        if (row.field.disabled) {
          return [];
        }
        if (row.field.hint) {
          return [{ key: "info", label: row.field.hint }];
        }
        return [];
      },
      handleKey() {
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/text.ts
import { Editor, matchesKey as matchesKey10 } from "@earendil-works/pi-tui";
import { getSelectListTheme as getSelectListTheme4 } from "@earendil-works/pi-coding-agent";
import { truncateToWidth as truncateToWidth5 } from "@earendil-works/pi-tui";
function formatTextPreview(value) {
  const lineCount = value.split("\n").length;
  const preview = value.replace(/\s+/g, " ").trim();
  const quoted = preview ? JSON.stringify(preview) : '""';
  const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";
  return `${truncateToWidth5(quoted, 48, "...")}${suffix}`;
}
function makeTextSubmenu(current, ctx) {
  return (done) => {
    const editor = new Editor(
      ctx.tui,
      {
        borderColor: (s) => ctx.theme.fg("muted", s),
        selectList: getSelectListTheme4()
      },
      {
        paddingX: 0
      }
    );
    editor.setText(current);
    editor.focused = true;
    editor.disableSubmit = true;
    editor.onChange = () => ctx.tui.requestRender();
    const component = {
      render(width) {
        const lines = editor.render(width);
        lines.push("");
        const hints = [
          { key: "ctrl+s", label: "save" },
          { key: "esc", label: "cancel" },
          { key: "ctrl+w", label: "delete word" },
          { key: "ctrl+u", label: "clear" },
          { key: "alt+r", label: "reset" }
        ];
        const hintLine = ctx.theme.fg("dim", formatHintLine(hints, ctx.theme));
        lines.push(truncateToWidth5(hintLine, width, "\u2026", true));
        return lines;
      },
      invalidate() {
        editor.invalidate();
      },
      handleInput(data) {
        if (matchesKey10(data, "ctrl+s")) {
          done(editor.getExpandedText());
          return;
        }
        if (matchesKey10(data, "escape")) {
          done();
          return;
        }
        if (matchesKey10(data, "ctrl+u")) {
          editor.setText("");
          ctx.tui.requestRender();
          return;
        }
        if (matchesKey10(data, "alt+r")) {
          editor.setText(current);
          ctx.tui.requestRender();
          return;
        }
        let inputData = data;
        if (matchesKey10(data, "backspace") || matchesKey10(data, "ctrl+h") || data === "\x7F" || data === "\b") {
          inputData = "\x7F";
        }
        editor.handleInput(inputData);
        ctx.tui.requestRender();
      }
    };
    return component;
  };
}
var textRenderer;
var init_text = __esm({
  "modules/blackhole/src/pi-base/settings/fields/text.ts"() {
    "use strict";
    init_frame();
    textRenderer = {
      type: "text",
      renderValue(row, { selected, ctx }) {
        const display = formatTextPreview(row.value);
        if (row.field.disabled) {
          return ctx.theme.fg("muted", display);
        }
        return ctx.theme.fg(selected ? "accent" : "muted", display);
      },
      hints(row) {
        if (row.field.disabled) return [];
        return [{ key: "enter", label: "open editor" }];
      },
      handleKey(row, data, { ctx }) {
        if (row.field.disabled) return {};
        if (data === "\r" || data === "\n") {
          return {
            consumed: true,
            submenu: makeTextSubmenu(row.value, ctx)
          };
        }
        return {};
      }
    };
  }
});

// modules/blackhole/src/pi-base/settings/fields/index.ts
var RENDERERS;
var init_fields = __esm({
  "modules/blackhole/src/pi-base/settings/fields/index.ts"() {
    "use strict";
    init_action();
    init_boolean();
    init_custom();
    init_enum();
    init_model();
    init_string();
    init_readonly();
    init_text();
    RENDERERS = {
      boolean: booleanRenderer,
      enum: enumRenderer,
      string: stringRenderer,
      number: numberRenderer,
      secret: secretRenderer,
      path: pathRenderer,
      text: textRenderer,
      action: actionRenderer,
      model: modelRenderer,
      custom: customRenderer,
      readonly: readonlyRenderer
    };
  }
});

// modules/blackhole/src/pi-base/settings/helpers.ts
function notifyError(_state, ctx, err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    ctx.ui.notify(message, "error");
  } catch {
  }
}
function extractInitialValue(field) {
  if (field.type === "action") return void 0;
  return field.value;
}
var init_helpers = __esm({
  "modules/blackhole/src/pi-base/settings/helpers.ts"() {
    "use strict";
  }
});

// modules/blackhole/src/pi-base/settings/navigation.ts
import { fuzzyMatch } from "@earendil-works/pi-tui";
function totalVisibleItems(state) {
  return state.cachedVisibleIndices.length;
}
function updateVisibleIndices(state, buildCtx) {
  const query = state.search.trim().toLowerCase();
  const out = [];
  const scope = state.activeTabId ?? "global";
  let visCtx;
  for (let i = 0; i < state.rows.length; i += 1) {
    const row = state.rows[i];
    if (state.activeTabId !== void 0 && state.tabs.length > 0) {
      const fallbackTab = state.tabs[0].id;
      const rowTab = row.field.tab ?? fallbackTab;
      if (rowTab !== state.activeTabId) continue;
    }
    if (row.field.visibleWhen) {
      if (!visCtx) {
        visCtx = buildCtx(state, row.field, scope);
      }
      if (!row.field.visibleWhen(visCtx)) continue;
    }
    if (!query) {
      out.push(i);
      continue;
    }
    const fuzzy = fuzzyMatch(query, row.searchIndex);
    if (fuzzy.matches) out.push(i);
  }
  state.cachedVisibleIndices = out;
}
function visibleRowIndices(state) {
  return state.cachedVisibleIndices;
}
function clampSelection(state, visibleRows) {
  const count = totalVisibleItems(state);
  state.fieldSelected = Math.max(0, Math.min(state.fieldSelected, Math.max(0, count - 1)));
  if (state.fieldSelected < state.scroll) state.scroll = state.fieldSelected;
  else if (state.fieldSelected >= state.scroll + visibleRows)
    state.scroll = state.fieldSelected - visibleRows + 1;
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, count - visibleRows)));
}
function focusedIndex(state) {
  const indices = visibleRowIndices(state);
  if (indices.length === 0) return void 0;
  const safe = Math.max(0, Math.min(state.fieldSelected, indices.length - 1));
  return indices[safe];
}
function focusedRow(state) {
  const idx = focusedIndex(state);
  return idx === void 0 ? void 0 : state.rows[idx];
}
var init_navigation = __esm({
  "modules/blackhole/src/pi-base/settings/navigation.ts"() {
    "use strict";
  }
});

// modules/blackhole/src/pi-base/settings/values.ts
function buildVisibilityContext(_state, _field, scope) {
  let cache = KEY_TO_ROW_CACHE.get(_state);
  if (!cache || cache.rows !== _state.rows || cache.rows.length !== _state.rows.length) {
    const map = /* @__PURE__ */ new Map();
    for (let i = 0; i < _state.rows.length; i += 1) {
      const r = _state.rows[i];
      map.set(r.field.key, r);
    }
    cache = { rows: _state.rows, map };
    KEY_TO_ROW_CACHE.set(_state, cache);
  }
  const rowsMap = cache.map;
  return {
    get: (key2) => rowsMap.get(key2)?.value,
    scope
  };
}
function isDirty(state) {
  if (!state.isBuffered) return false;
  return state.dirtyKeys.size > 0;
}
function syncDirtyState(state, key2, row) {
  if (!state.isBuffered) return;
  const initial = state.initialValues.get(key2);
  const targetRow = row ?? state.rows.find((r) => r.field.key === key2);
  const current = targetRow?.value;
  let isClean;
  if (typeof initial === "object" && initial !== null) {
    let initialJson = INITIAL_JSON_CACHE.get(initial);
    if (initialJson === void 0) {
      initialJson = JSON.stringify(initial);
      INITIAL_JSON_CACHE.set(initial, initialJson);
    }
    if (current === void 0) {
      isClean = initial === void 0;
    } else {
      const currentJson = JSON.stringify(current);
      isClean = currentJson === initialJson;
    }
  } else {
    isClean = current === initial;
  }
  if (isClean) {
    state.dirtyKeys.delete(key2);
  } else {
    state.dirtyKeys.add(key2);
  }
}
function commitValue(state, row, value) {
  const previous = row.value;
  const key2 = row.field.key;
  row.value = value;
  if (state.isBuffered) {
    syncDirtyState(state, key2, row);
  }
  updateVisibleIndices(state, buildVisibilityContext);
  try {
    const ret = state.options.onChange?.(
      row.field.key,
      value,
      row.field
    );
    if (ret && typeof ret.then === "function") {
      ret.then(() => {
        if (state.isBuffered) {
          state.args.tui.requestRender();
        }
      }).catch((err) => {
        if (row.value === value) {
          row.value = previous;
        }
        if (state.isBuffered) {
          syncDirtyState(state, key2, row);
        }
        notifyError(state, state.args.ctx, err);
        state.args.tui.requestRender();
      });
    }
  } catch (err) {
    row.value = previous;
    if (state.isBuffered) {
      syncDirtyState(state, key2, row);
    }
    notifyError(state, state.args.ctx, err);
    state.args.tui.requestRender();
  }
}
function allValues(state) {
  const out = {};
  for (const row of state.rows) {
    out[row.field.key] = row.value;
  }
  return out;
}
var INITIAL_JSON_CACHE, KEY_TO_ROW_CACHE;
var init_values = __esm({
  "modules/blackhole/src/pi-base/settings/values.ts"() {
    "use strict";
    init_helpers();
    init_navigation();
    INITIAL_JSON_CACHE = /* @__PURE__ */ new WeakMap();
    KEY_TO_ROW_CACHE = /* @__PURE__ */ new WeakMap();
  }
});

// modules/blackhole/src/pi-base/settings/validate-field.ts
function validateFieldValue(field, value) {
  if (value === void 0 || value === null) return void 0;
  switch (field.type) {
    case "enum": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      if (!field.options.includes(value))
        return `Must be one of: ${field.options.join(", ")}`;
      return void 0;
    }
    case "boolean": {
      if (typeof value !== "boolean") return `Must be a boolean, got ${typeof value}`;
      return void 0;
    }
    case "string": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      if (value.includes("\n") || value.includes("\r"))
        return "Must be a single-line string (no newlines)";
      return void 0;
    }
    case "text": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return void 0;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return `Must be a finite number, got ${typeof value === "number" ? String(value) : typeof value}`;
      if (field.integer && !Number.isInteger(value)) return "Must be an integer";
      if (field.values !== void 0 && field.values.length > 0) {
        if (!field.values.includes(value)) return `Must be one of: ${field.values.join(", ")}`;
      }
      if (typeof field.min === "number" && value < field.min)
        return `Must be at least ${field.min}`;
      if (typeof field.max === "number" && value > field.max) return `Must be at most ${field.max}`;
      if (field.step !== void 0 && field.step > 0) {
        const min = field.min ?? 0;
        const offset = value - min;
        const rem = offset % field.step;
        if (rem > 1e-9 && field.step - rem > 1e-9) {
          return `Must be aligned to step ${field.step}`;
        }
      }
      return void 0;
    }
    case "secret": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return void 0;
    }
    case "path": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return void 0;
    }
    case "model": {
      if (typeof value !== "object" || value === null)
        return `Must be an object with id, got ${typeof value}`;
      const v = value;
      if (typeof v.id !== "string") return `Must have a string id, got ${typeof v.id}`;
      return void 0;
    }
    case "action":
    case "custom":
      return void 0;
    default:
      return void 0;
  }
}
var init_validate_field = __esm({
  "modules/blackhole/src/pi-base/settings/validate-field.ts"() {
    "use strict";
  }
});

// modules/blackhole/src/pi-base/settings/render.ts
import { truncateToWidth as truncateToWidth6, visibleWidth as visibleWidth2 } from "@earendil-works/pi-tui";
function renderTabBar(state, width) {
  if (state.tabs.length === 0) return "";
  const cells = [];
  let cache = state._keyToTabCache;
  if (!cache || cache.rows !== state.rows || cache.rows.length !== state.rows.length) {
    const keyToTab = /* @__PURE__ */ new Map();
    const fallbackTab = state.tabs[0]?.id;
    for (const r of state.rows) {
      keyToTab.set(r.field.key, r.field.tab ?? fallbackTab);
    }
    cache = { rows: state.rows, map: keyToTab };
    state._keyToTabCache = cache;
  }
  const dirtyTabIds = /* @__PURE__ */ new Set();
  if (state.isBuffered && state.dirtyKeys.size > 0) {
    for (const key2 of state.dirtyKeys) {
      const tabId = cache.map.get(key2);
      if (tabId !== void 0) {
        dirtyTabIds.add(tabId);
      }
    }
  }
  for (const tab of state.tabs) {
    let label = tab.label;
    if (state.isBuffered && dirtyTabIds.has(tab.id)) {
      label += " \u25CF Unsaved";
    }
    const isFocused = state.tabActionFocus >= 0 && state.tabActionFocus < state.tabs.length && state.tabs[state.tabActionFocus]?.id === tab.id;
    if (tab.id === state.activeTabId) {
      const prefix = isFocused ? "\u25B6" : "\u25B8";
      const padded = ` ${prefix} ${label} `;
      cells.push(
        state.args.theme.fg("accent", state.args.theme.inverse(state.args.theme.bold(padded)))
      );
    } else if (isFocused) {
      const padded = ` \u25B6 ${label} `;
      cells.push(
        state.args.theme.fg("accent", state.args.theme.inverse(state.args.theme.bold(padded)))
      );
    } else {
      const padded = `   ${label} `;
      cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("accent", padded)));
    }
  }
  return pad2(cells.join(" "), width);
}
function renderSearchBar(state, width, hasMatches = true) {
  const cursor = state.args.theme.inverse(" ");
  let text;
  if (state.search === "") {
    let placeholderText = state.options.searchPlaceholder;
    if (!placeholderText) {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
      placeholderText = activeTab ? `Search ${activeTab.label}...` : "Search settings...";
    }
    const placeholder = state.args.theme.fg("muted", placeholderText);
    text = ` > ${cursor}${placeholder}`;
  } else {
    if (!hasMatches) {
      text = ` > ${state.args.theme.fg("warning", state.search)}${cursor}`;
    } else {
      text = ` > ${state.search}${cursor}`;
    }
  }
  return state.args.theme.bg("toolPendingBg", pad2(text, width));
}
function renderFooter(state, rendererFor, _width) {
  const row = focusedRow(state);
  let rowHints = [];
  if (row && !state.options.readOnly && row.field.type !== "section" && !row.field.disabled) {
    const renderer = rendererFor(row.field);
    rowHints = [
      ...renderer.hints(
        { field: row.field, value: row.value },
        { isEditing: row.isEditing }
      )
    ];
    if (!row.isEditing && row.field.default !== void 0) {
      if (!rowHints.some((h) => h.key === "alt+r" || h.key === "ctrl+r")) {
        rowHints.push({ key: "alt+r", label: "reset" });
      }
    }
  }
  const line1 = [];
  if (state.tabs.length > 0 || (state.options.actions?.length ?? 0) > 0) {
    line1.push({ key: "tab/shift+tab", label: "cycle" });
  }
  if (state.tabActionFocus >= 0 && !state.options.readOnly) {
    line1.push({ key: "\u2190/\u2192", label: "navigate" });
  }
  line1.push({ key: "\u2191\u2193", label: "move" });
  if (!state.options.readOnly && !row?.isEditing && row?.field.reorderable) {
    line1.push({ key: "alt+\u2191\u2193", label: "reorder" });
  }
  let anyFieldHasDefault = state._anyFieldHasDefault;
  if (anyFieldHasDefault === void 0) {
    anyFieldHasDefault = state.fields.some(
      (f) => f.default !== void 0
    );
    state._anyFieldHasDefault = anyFieldHasDefault;
  }
  if (anyFieldHasDefault && !state.options.readOnly && !row?.isEditing) {
    line1.push({ key: "ctrl+r", label: "reset field" });
  }
  if (state.options.readOnly && state.tabs.length > 0 && (state.options.actions?.length ?? 0) > 0) {
    line1.push({ key: "\u2190 \u2192", label: "navigate" });
  }
  if (state.isBuffered) {
    line1.push({ key: "ctrl+s", label: "save" });
  }
  if (state.options.enableSearch && !row?.isEditing) {
    if (state.search === "") {
      line1.push({ key: "type", label: "to search" });
    } else {
      line1.push({ key: "ctrl+w", label: "delete word" });
      line1.push({ key: "ctrl+u", label: "clear" });
    }
  }
  const line2 = [];
  const actionCount = state.options.actions?.length ?? 0;
  if (state.tabActionFocus >= state.tabs.length && state.tabActionFocus < state.tabs.length + actionCount && actionCount > 0) {
    line2.push({ key: "enter", label: "trigger action" });
  } else {
    line2.push(...rowHints);
  }
  if (state.confirm) {
    line2.push({ key: "\u2191\u2193", label: "select" });
    line2.push({ key: "enter/space", label: "confirm" });
    line2.push({ key: "esc", label: "cancel" });
  } else if (state.options.enableSearch && state.search !== "" && !row?.isEditing) {
    line2.push({ key: "esc", label: "clear search" });
  } else if (state.isBuffered && isDirty(state)) {
    line2.push({ key: "esc", label: "confirm \u2192" });
  } else {
    line2.push({ key: "esc", label: "close" });
  }
  const lines = [formatHintLine(line1, state.args.theme)];
  if (line2.length > 1 || line2.length === 1 && line2[0].key !== "esc") {
    lines.push(formatHintLine(line2, state.args.theme));
  }
  return lines;
}
function renderRow(state, rendererFor, fieldRenderContext, row, width, isSelected) {
  if (row.field.type === "section") {
    const title = row.field.value;
    const prefix2 = isSelected ? state.args.theme.fg("accent", "\u258C ") : "  ";
    const composed2 = `${prefix2}${state.args.theme.fg("dim", title)}`;
    if (isSelected) return state.args.theme.bg("selectedBg", pad2(composed2, width));
    return truncateToWidth6(composed2, width, "\u2026");
  }
  let labelCache = row._labelCache;
  if (!labelCache || labelCache.width !== width) {
    const labelAlloc2 = Math.min(55, Math.max(28, Math.floor(width * 0.5)));
    const labelText2 = truncateToWidth6(row.field.label, labelAlloc2, "\u2026");
    const labelPadding2 = " ".repeat(Math.max(1, labelAlloc2 - visibleWidth2(labelText2)));
    labelCache = { width, labelText: labelText2, labelPadding: labelPadding2, labelAlloc: labelAlloc2 };
    row._labelCache = labelCache;
  }
  const { labelText, labelPadding, labelAlloc } = labelCache;
  const valueWidth = Math.max(1, width - labelAlloc - 4);
  const dimRaw = row.field.disabled ? true : row.field.dim;
  const dimFlag = typeof dimRaw === "function" ? dimRaw() : dimRaw;
  const labelColor = dimFlag === true ? "muted" : dimFlag === false ? "text" : isSelected ? "text" : "muted";
  const label = state.args.theme.fg(labelColor, labelText);
  const renderer = rendererFor(row.field);
  const valueText = renderer.renderValue(
    { field: row.field, value: row.value },
    {
      width: valueWidth,
      selected: isSelected,
      isEditing: row.isEditing,
      ctx: fieldRenderContext
    }
  );
  const padding = labelPadding;
  let depthIndent = row._depthIndent;
  if (depthIndent === void 0) {
    depthIndent = "  ".repeat(row.field.depth ?? 0);
    row._depthIndent = depthIndent;
  }
  const prefix = isSelected ? state.args.theme.fg("accent", `${depthIndent}\u258C `) : `${depthIndent}  `;
  let note = "";
  const rawValueNote = row.field.valueNote;
  if (rawValueNote) {
    const resolved = typeof rawValueNote === "function" ? rawValueNote() : rawValueNote;
    if (resolved) note += ` ${state.args.theme.fg("dim", resolved)}`;
  }
  const composed = `${prefix}${label}${padding}${valueText}${note}`;
  if (isSelected) return state.args.theme.bg("selectedBg", pad2(composed, width));
  return truncateToWidth6(composed, width, "\u2026");
}
function renderBody(state, rendererFor, fieldRenderContext, width, innerRows) {
  const lines = [];
  if (state.tabs.length > 0) {
    lines.push(renderTabBar(state, width));
  }
  const indices = visibleRowIndices(state);
  if (state.options.enableSearch) {
    if (lines.length > 0) lines.push("");
    lines.push(renderSearchBar(state, width, indices.length > 0));
  }
  if (lines.length > 0) {
    lines.push("");
    lines.push(divider(width, state.args.theme));
  }
  const pathNote = state.pathNoteRef.current ?? state.pathNote;
  if (pathNote) {
    lines.push(state.args.theme.fg("dim", truncateToWidth6(pathNote, width, "\u2026")));
  }
  const visibleListRows = Math.max(
    3,
    innerRows - lines.length - 2 - estimateDescriptionRows(state)
  );
  clampSelection(state, visibleListRows);
  const fieldCount = indices.length;
  const slice = indices.slice(state.scroll, state.scroll + visibleListRows);
  if (slice.length === 0) {
    if (state.search) {
      const prefix = state.args.theme.fg("muted", "  No matching settings for '");
      const q = state.args.theme.fg("warning", state.search);
      const suffix = state.args.theme.fg("muted", "'. (press esc or ctrl+u to clear)");
      lines.push(`${prefix}${q}${suffix}`);
    } else {
      lines.push(state.args.theme.fg("muted", "  No settings available in this tab."));
    }
  } else {
    if (state.scroll > 0) lines.push(state.args.theme.fg("dim", `  \u2191 ${state.scroll} earlier`));
    for (let visIdx = 0; visIdx < slice.length; visIdx++) {
      const idx = slice[visIdx];
      const realIdx = state.scroll + visIdx;
      const row = state.rows[idx];
      lines.push(
        renderRow(
          state,
          rendererFor,
          fieldRenderContext,
          row,
          width,
          realIdx === state.fieldSelected
        )
      );
    }
    const hidden = Math.max(0, fieldCount - (state.scroll + visibleListRows));
    if (hidden > 0) lines.push(state.args.theme.fg("dim", `  \u2193 ${hidden} more`));
  }
  const focused = focusedRow(state);
  if (focused) {
    renderFieldDesc(state, lines, width, focused);
  }
  while (lines.length < innerRows) lines.push("");
  return lines;
}
function renderFieldDesc(state, lines, width, focused) {
  let desc = focused.field.description ?? "";
  const field = focused.field;
  if (field.disabled) {
    const disabledNote = "This setting is currently disabled.";
    desc = desc ? `${desc} (${disabledNote})` : disabledNote;
  }
  if (field.type === "number") {
    const parts = [];
    if (field.values) {
      parts.push(`values: ${field.values.join(", ")}`);
    } else {
      if (typeof field.min === "number" && typeof field.max === "number") {
        parts.push(`range: ${field.min} to ${field.max}`);
      } else if (typeof field.min === "number") {
        parts.push(`min: ${field.min}`);
      } else if (typeof field.max === "number") {
        parts.push(`max: ${field.max}`);
      }
      if (field.integer) parts.push("integer only");
    }
    if (parts.length > 0) {
      const suffix = `(${parts.join(", ")})`;
      desc = desc ? `${desc} ${suffix}` : suffix;
    }
  }
  if (desc) {
    lines.push("");
    for (const line of wrapLine(desc, Math.max(1, width - 4))) {
      lines.push(state.args.theme.fg("muted", `  ${line}`));
    }
  }
  let vdText;
  if (field.type === "boolean") {
    const vd = field.valueDescriptions;
    if (vd) {
      const key2 = focused.value ? "on" : "off";
      vdText = vd[key2];
    }
  } else if (field.type === "enum") {
    const vd = field.valueDescriptions;
    if (vd) {
      vdText = vd[focused.value];
    }
  } else if (field.type === "number") {
    const vd = field.valueDescriptions;
    if (vd) {
      vdText = vd[String(focused.value)];
    }
  }
  if (vdText) {
    lines.push("");
    const vdColor = field.disabled ? "muted" : "accent";
    for (const line of wrapLine(state.args.theme.fg(vdColor, vdText), Math.max(1, width - 4))) {
      lines.push(`  ${line}`);
    }
  }
  const warning = validateFieldValue(focused.field, focused.value);
  if (warning) {
    lines.push("");
    for (const line of wrapLine(warning, Math.max(1, width - 4))) {
      lines.push(state.args.theme.fg("warning", `  ${line}`));
    }
  }
}
function estimateDescriptionRows(state) {
  const focused = focusedRow(state);
  if (!focused) return 0;
  let estimate = 0;
  if (focused.field.description || focused.field.disabled) estimate = 2;
  const field = focused.field;
  if (field.type === "number") {
    if (typeof field.min === "number" || typeof field.max === "number" || field.integer) {
      estimate = Math.max(estimate, 2);
    }
  }
  const warning = validateFieldValue(focused.field, focused.value);
  if (warning) estimate = Math.max(estimate, 1);
  return estimate;
}
var init_render = __esm({
  "modules/blackhole/src/pi-base/settings/render.ts"() {
    "use strict";
    init_frame();
    init_validate_field();
    init_navigation();
    init_values();
  }
});

// modules/blackhole/src/pi-base/settings/body.ts
import {
  matchesKey as matchesKey11
} from "@earendil-works/pi-tui";
function createSettingsModalBody(options, args) {
  const tabs = options.tabs ?? [];
  const fields = options.fields;
  const mode2 = options.mode ?? "immediate";
  const isBuffered = mode2 === "buffered";
  const readOnly = options.readOnly ?? false;
  let activeTabId = options.initialTab ?? tabs[0]?.id;
  const rows = fields.map((field) => ({
    field,
    value: extractInitialValue(field),
    isEditing: false,
    searchIndex: `${field.label}
${field.description ?? ""}
${field.key}`.toLowerCase()
  }));
  const editStates = /* @__PURE__ */ new Map();
  const initialValues = /* @__PURE__ */ new Map();
  const dirtyKeys = /* @__PURE__ */ new Set();
  if (isBuffered) {
    for (const row of rows) {
      const val = row.value;
      initialValues.set(
        row.field.key,
        typeof val === "object" && val !== null ? structuredClone(val) : val
      );
    }
  }
  let overlay;
  let confirm;
  const fieldRenderContext = {
    theme: args.theme,
    tui: args.tui,
    ctx: args.ctx,
    requestRender: () => args.tui.requestRender(),
    editStates
  };
  const state = {
    options,
    args,
    tabs,
    fields,
    rows,
    editStates,
    isBuffered,
    initialValues,
    dirtyKeys,
    cachedVisibleIndices: [],
    activeTabId,
    search: "",
    fieldSelected: 0,
    scroll: 0,
    tabActionFocus: readOnly && tabs.length > 0 && (options.actions?.length ?? 0) > 0 ? tabs.length : -1,
    pathNote: options.pathNote ?? "",
    pathNoteRef: { current: options.pathNote ?? "" },
    overlay,
    confirm
  };
  updateVisibleIndices(state, buildVisibilityContext);
  function mountOverlay(c, title) {
    state.overlay = { component: c, title };
    state.args.tui.requestRender();
  }
  function dismissOverlay() {
    state.overlay = void 0;
    state.args.tui.requestRender();
  }
  function getActiveTabId() {
    return state.activeTabId;
  }
  function setValues(values) {
    for (const row of state.rows) {
      if (values[row.field.key] !== void 0) {
        row.value = values[row.field.key];
      }
    }
    state.dirtyKeys.clear();
    state.initialValues.clear();
    for (const row of state.rows) {
      const val = row.value;
      state.initialValues.set(
        row.field.key,
        typeof val === "object" && val !== null ? structuredClone(val) : val
      );
    }
    state.args.tui.requestRender();
  }
  function mountDirtyConfirm() {
    state.confirm = createConfirm(
      {
        message: ["You have unsaved changes."],
        confirmLabel: "Discard",
        cancelLabel: "Cancel",
        danger: true
      },
      (confirmed) => {
        state.confirm = void 0;
        if (confirmed) {
          state.options.onCancel?.();
          state.args.close();
        }
        state.args.tui.requestRender();
      },
      { tui: state.args.tui, theme: state.args.theme }
    );
    state.args.tui.requestRender();
  }
  function setEditing(row, value) {
    row.isEditing = value;
  }
  function rendererFor(field) {
    return RENDERERS[field.type];
  }
  function actionLabel(action) {
    if (typeof action.disabled === "function") {
      return action.disabled() ? `${action.label} (disabled)` : action.label;
    }
    if (action.disabled) return `${action.label} (disabled)`;
    return action.label;
  }
  function dispatchKey(data) {
    if (readOnly) return;
    const row = focusedRow(state);
    if (!row) return;
    const renderer = rendererFor(row.field);
    try {
      if (renderer) {
        const result = renderer.handleKey(
          { field: row.field, value: row.value },
          data,
          {
            isEditing: row.isEditing,
            ctx: fieldRenderContext,
            setEditing: (v) => setEditing(row, v)
          }
        );
        if (result.commit !== void 0) commitValue(state, row, result.commit);
        if (result.submenu) {
          mountOverlay(
            result.submenu((value) => {
              dismissOverlay();
              if (value !== void 0) commitValue(state, row, value);
            }),
            `${row.field.key} \u2192`
          );
        }
      }
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
  }
  function handleReorder(direction) {
    if (readOnly) return true;
    const focusedIdx = focusedIndex(state);
    if (focusedIdx === void 0) return false;
    const focusedRowInternal = state.rows[focusedIdx];
    if (!focusedRowInternal?.field.reorderable) return false;
    const indices = visibleRowIndices(state);
    const visiblePos = indices.indexOf(focusedIdx);
    const targetVisiblePos = visiblePos + direction;
    if (targetVisiblePos < 0 || targetVisiblePos >= indices.length) {
      return true;
    }
    const targetIdx = indices[targetVisiblePos];
    const targetRow = state.rows[targetIdx];
    if (!targetRow?.field.reorderable) {
      return true;
    }
    const reorderablePeerIdxs = indices.filter((i) => state.rows[i]?.field.reorderable);
    const fromPeerPos = reorderablePeerIdxs.indexOf(focusedIdx);
    const toPeerPos = reorderablePeerIdxs.indexOf(targetIdx);
    state.rows[focusedIdx] = targetRow;
    state.rows[targetIdx] = focusedRowInternal;
    state.fieldSelected = targetVisiblePos;
    updateVisibleIndices(state, buildVisibilityContext);
    try {
      state.options.onReorder?.({
        fieldKey: focusedRowInternal.field.key,
        fromIndex: fromPeerPos,
        toIndex: toPeerPos
      });
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
    state.args.tui.requestRender();
    return true;
  }
  async function performSave() {
    if (!state.options.onSave) return;
    try {
      const values = allValues(state);
      const result = state.options.onSave(values);
      if (result && typeof result.then === "function") {
        await result;
      }
      if (state.options.closeOnSave !== false) {
        state.args.close();
      }
    } catch (err) {
      notifyError(state, state.args.ctx, err);
    }
  }
  function handleInput(data) {
    if (state.confirm) {
      state.confirm.handleInput?.(data);
      return;
    }
    if (state.overlay) {
      state.overlay.component.handleInput?.(data);
      return;
    }
    const row = focusedRow(state);
    if (matchesKey11(data, "ctrl+s")) {
      if (state.isBuffered && state.options.onSave) {
        void performSave();
      }
      return;
    }
    if (matchesKey11(data, "ctrl+r") || matchesKey11(data, "alt+r")) {
      if (readOnly) return;
      const row2 = focusedRow(state);
      if (row2 && !row2.field.disabled && !row2.isEditing) {
        const def = row2.field.default;
        if (def !== void 0) {
          const clonedDef = typeof def === "object" && def !== null ? structuredClone(def) : def;
          commitValue(state, row2, clonedDef);
          state.args.tui.requestRender();
          return;
        }
      }
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey11(data, "alt+up")) {
      if (handleReorder(-1)) return;
    }
    if (matchesKey11(data, "alt+down")) {
      if (handleReorder(1)) return;
    }
    if (row?.isEditing && matchesKey11(data, "ctrl+c")) {
      if (state.isBuffered && isDirty(state)) {
        mountDirtyConfirm();
      } else {
        state.args.close();
      }
      return;
    }
    if (row?.isEditing) {
      dispatchKey(data);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey11(data, "escape")) {
      if (state.tabActionFocus >= 0) {
        state.tabActionFocus = -1;
        state.args.tui.requestRender();
        return;
      }
      if (state.options.enableSearch && state.search !== "") {
        state.search = "";
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (state.isBuffered && isDirty(state)) {
        if (state.options.onRequestExit) {
          state.options.onRequestExit();
        } else {
          mountDirtyConfirm();
        }
      } else {
        state.args.close();
      }
      return;
    }
    if (matchesKey11(data, "ctrl+c")) {
      if (state.isBuffered && isDirty(state)) {
        if (state.options.onRequestExit) {
          state.options.onRequestExit();
        } else {
          mountDirtyConfirm();
        }
      } else {
        state.args.close();
      }
      return;
    }
    const actions = state.options.actions ?? [];
    const stopCount = readOnly ? state.tabs.length : state.tabs.length + actions.length;
    if (matchesKey11(data, "tab")) {
      if (stopCount === 0) {
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (currentTabIdx >= 0) {
          state.tabActionFocus = (currentTabIdx + 1) % stopCount;
        } else {
          state.tabActionFocus = 0;
        }
      } else if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = (state.tabActionFocus + 1) % stopCount;
      } else if (readOnly) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const nextTabIdx = currentTabIdx >= 0 ? (currentTabIdx + 1) % state.tabs.length : 0;
        const nextTab = state.tabs[nextTabIdx];
        if (nextTab && nextTab.id !== state.activeTabId) {
          state.activeTabId = nextTab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(nextTab.id);
        }
        state.args.tui.requestRender();
        return;
      } else {
        state.tabActionFocus = (state.tabActionFocus + 1) % stopCount;
      }
      if (state.tabActionFocus < state.tabs.length) {
        const tab = state.tabs[state.tabActionFocus];
        if (tab && tab.id !== state.activeTabId) {
          state.activeTabId = tab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(tab.id);
        }
      }
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey11(data, "shift+tab")) {
      if (stopCount === 0) {
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (currentTabIdx >= 0) {
          state.tabActionFocus = (currentTabIdx - 1 + stopCount) % stopCount;
        } else {
          state.tabActionFocus = stopCount - 1;
        }
      } else if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = (state.tabActionFocus - 1 + stopCount) % stopCount;
      } else if (readOnly) {
        const currentTabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        const prevTabIdx = currentTabIdx >= 0 ? (currentTabIdx - 1 + state.tabs.length) % state.tabs.length : state.tabs.length - 1;
        const prevTab = state.tabs[prevTabIdx];
        if (prevTab && prevTab.id !== state.activeTabId) {
          state.activeTabId = prevTab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(prevTab.id);
        }
        state.args.tui.requestRender();
        return;
      } else {
        state.tabActionFocus = (state.tabActionFocus - 1 + stopCount) % stopCount;
      }
      if (state.tabActionFocus < state.tabs.length) {
        const tab = state.tabs[state.tabActionFocus];
        if (tab && tab.id !== state.activeTabId) {
          state.activeTabId = tab.id;
          state.fieldSelected = 0;
          state.scroll = 0;
          updateVisibleIndices(state, buildVisibilityContext);
          state.options.onActiveTabChange?.(tab.id);
        }
      }
      state.args.tui.requestRender();
      return;
    }
    const ringActions = state.options.actions ?? [];
    const ringStopCount = state.tabs.length + ringActions.length;
    if ((matchesKey11(data, "left") || matchesKey11(data, "right")) && ringStopCount > 0) {
      if (state.tabActionFocus >= 0) {
        const forward = matchesKey11(data, "right");
        if (readOnly && state.tabs.length > 0 && ringActions.length > 0) {
          if (state.tabActionFocus < state.tabs.length) {
            if (forward) {
              state.tabActionFocus = state.tabs.length;
            } else {
              state.tabActionFocus = state.tabs.length + ringActions.length - 1;
            }
          } else {
            const actionCount = ringActions.length;
            const currentActionIdx = state.tabActionFocus - state.tabs.length;
            state.tabActionFocus = state.tabs.length + (forward ? (currentActionIdx + 1) % actionCount : (currentActionIdx - 1 + actionCount) % actionCount);
          }
        } else {
          state.tabActionFocus = forward ? (state.tabActionFocus + 1) % ringStopCount : (state.tabActionFocus - 1 + ringStopCount) % ringStopCount;
          if (state.tabActionFocus < state.tabs.length) {
            const tab = state.tabs[state.tabActionFocus];
            if (tab && tab.id !== state.activeTabId) {
              state.activeTabId = tab.id;
              state.fieldSelected = 0;
              state.scroll = 0;
              updateVisibleIndices(state, buildVisibilityContext);
              state.options.onActiveTabChange?.(tab.id);
            }
          }
        }
        state.args.tui.requestRender();
        return;
      }
      if (state.tabActionFocus === -1 && readOnly && ringActions.length > 0) {
        if (matchesKey11(data, "right")) {
          state.tabActionFocus = state.tabs.length;
        } else {
          state.tabActionFocus = state.tabs.length + ringActions.length - 1;
        }
        state.args.tui.requestRender();
        return;
      }
    }
    const totalCount = totalVisibleItems(state);
    const lastIndex = Math.max(0, totalCount - 1);
    if (matchesKey11(data, "up") || matchesKey11(data, "down") || matchesKey11(data, "pageUp") || matchesKey11(data, "pageDown")) {
      state.tabActionFocus = -1;
    }
    if (matchesKey11(data, "up")) {
      state.fieldSelected = Math.max(0, state.fieldSelected - 1);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey11(data, "down")) {
      state.fieldSelected = Math.min(lastIndex, state.fieldSelected + 1);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey11(data, "pageUp")) {
      state.fieldSelected = Math.max(0, state.fieldSelected - 5);
      state.args.tui.requestRender();
      return;
    }
    if (matchesKey11(data, "pageDown")) {
      state.fieldSelected = Math.min(lastIndex, state.fieldSelected + 5);
      state.args.tui.requestRender();
      return;
    }
    if ((matchesKey11(data, "enter") || matchesKey11(data, "return")) && state.tabActionFocus >= 0) {
      if (state.tabActionFocus < state.tabs.length) {
        state.tabActionFocus = -1;
      } else if (actions.length > 0) {
        const actionIdx = state.tabActionFocus - state.tabs.length;
        const action = actions[actionIdx];
        if (action) {
          const disabled = typeof action.disabled === "function" ? action.disabled() : action.disabled;
          if (!disabled) {
            state.options.onAction?.(action.id);
          }
        }
        state.args.tui.requestRender();
        return;
      }
    }
    if (state.options.enableSearch) {
      if (matchesKey11(data, "backspace") || matchesKey11(data, "ctrl+h")) {
        state.search = state.search.slice(0, -1);
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (matchesKey11(data, "ctrl+u")) {
        state.search = "";
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
      if (matchesKey11(data, "ctrl+w")) {
        state.search = deleteWordBackward(state.search);
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
        state.args.tui.requestRender();
        return;
      }
    }
    dispatchKey(data);
    if (state.options.enableSearch && data.length === 1 && data >= " " && data !== "\x7F" && !row?.isEditing) {
      if (!row || !row.isEditing) {
        state.search += data;
        state.fieldSelected = 0;
        updateVisibleIndices(state, buildVisibilityContext);
      }
    }
    state.args.tui.requestRender();
  }
  return {
    render(width) {
      const inner = responsiveInnerRows(
        state.args.tui.terminal.rows ?? 24,
        PREFERRED_INNER_ROWS,
        14
      );
      if (state.confirm) {
        const lines = state.confirm.render(frameContentWidth(width));
        const title2 = state.options.title ? `${state.options.title} \u2014 Discard changes?` : "Discard changes?";
        const opts = {
          title: title2,
          fixedInnerRows: inner
        };
        return frame(lines, width, state.args.theme, opts);
      }
      if (state.overlay) {
        const lines = state.overlay.component.render(frameContentWidth(width));
        const title2 = state.overlay.title ?? state.options.title;
        const opts = {
          title: title2,
          fixedInnerRows: inner
        };
        return frame(lines, width, state.args.theme, opts);
      }
      const contentWidth = frameContentWidth(width);
      const footerRows = renderFooter(state, rendererFor, contentWidth);
      const footerSectionHeight = 1 + footerRows.length;
      const actions = state.options.actions ?? [];
      const actionSectionHeight = actions.length > 0 ? 2 : 0;
      const bottomSectionHeight = footerSectionHeight + actionSectionHeight;
      const bodyInnerRows = inner - bottomSectionHeight;
      const bodyLines = renderBody(
        state,
        rendererFor,
        fieldRenderContext,
        contentWidth,
        bodyInnerRows
      );
      const dirtyDot = state.isBuffered && isDirty(state) ? ` ${state.args.theme.fg("accent", "\u25CF Unsaved")}` : "";
      const title = state.options.title ? `${state.options.title}${dirtyDot}` : state.options.title;
      const frameLines = frame(bodyLines, width, state.args.theme, {
        title,
        fixedInnerRows: bodyInnerRows
      });
      const bottomBorder = frameLines.pop();
      const bottomPadding = frameLines.pop();
      const borderAccent = (s) => state.args.theme.fg("borderAccent", s);
      const paddingX = DEFAULT_PADDING_X;
      const footDiv = `${borderAccent("\u2502")}${" ".repeat(paddingX)}${state.args.theme.fg("dim", "\u2500".repeat(Math.max(1, contentWidth)))}${" ".repeat(paddingX)}${borderAccent("\u2502")}`;
      frameLines.push(footDiv);
      for (const line of footerRows) {
        const paddedLine = `  ${line}`;
        frameLines.push(
          `${borderAccent("\u2502")}${" ".repeat(paddingX)}${pad2(paddedLine, contentWidth)}${" ".repeat(paddingX)}${borderAccent("\u2502")}`
        );
      }
      if (actions.length > 0) {
        const actDiv = `${borderAccent("\u2502")}${" ".repeat(paddingX)}${state.args.theme.fg("dim", "\u2500".repeat(Math.max(1, contentWidth)))}${" ".repeat(paddingX)}${borderAccent("\u2502")}`;
        frameLines.push(actDiv);
        const cells = [];
        for (let ai = 0; ai < actions.length; ai++) {
          const action = actions[ai];
          const isFocused = state.tabActionFocus >= state.tabs.length && state.tabActionFocus - state.tabs.length === ai;
          const rawLabel = actionLabel(action);
          const padded = ` ${rawLabel} `;
          if (isFocused) {
            cells.push(
              state.args.theme.fg(
                "accent",
                state.args.theme.inverse(state.args.theme.bold(padded))
              )
            );
          } else if (action.danger) {
            cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("warning", padded)));
          } else {
            cells.push(state.args.theme.bg("selectedBg", state.args.theme.fg("accent", padded)));
          }
        }
        const line = pad2(cells.join(" "), contentWidth);
        frameLines.push(
          `${borderAccent("\u2502")}${" ".repeat(paddingX)}${line}${" ".repeat(paddingX)}${borderAccent("\u2502")}`
        );
      }
      frameLines.push(bottomPadding);
      frameLines.push(bottomBorder);
      return frameLines;
    },
    invalidate() {
      state.overlay?.component.invalidate?.();
      state.confirm?.invalidate?.();
    },
    handleInput,
    mountOverlay,
    dismissOverlay,
    getActiveTabId,
    setValues
  };
}
var PREFERRED_INNER_ROWS;
var init_body = __esm({
  "modules/blackhole/src/pi-base/settings/body.ts"() {
    "use strict";
    init_fields();
    init_frame();
    init_inline_edit();
    init_helpers();
    init_navigation();
    init_values();
    init_render();
    init_confirm();
    PREFERRED_INNER_ROWS = 45;
  }
});

// modules/blackhole/src/pi-base/settings/config-flow.ts
function buildSelectorEntries(params, includeDisplayAll = true, extraEntries = []) {
  const available = {
    global: params.scopes.global,
    project: params.scopes.project,
    session: params.scopes.session && params.sessionInitialized
  };
  const entries = [];
  if (includeDisplayAll) {
    entries.push({ id: "display-all", label: "Display all settings", available: true });
  }
  for (const id of SCOPE_IDS) {
    const ok = available[id];
    const entry = {
      id,
      label: SELECTOR_ENTRY_LABELS[id],
      available: ok,
      note: !ok ? id === "session" ? params.scopes.session ? "(session not initialized)" : "(disabled by extension)" : "(disabled by extension)" : void 0
    };
    entries.push(entry);
  }
  if (extraEntries.length > 0) {
    entries.push(...extraEntries);
  }
  return entries;
}
function winnerLabel(winner) {
  return SCOPE_LABELS[winner] ?? winner;
}
function precedenceRank(layer) {
  const rank = LAYER_PRECEDENCE[layer];
  return rank ?? -1;
}
function layerValueNote(winner, layer) {
  if (precedenceRank(winner) < precedenceRank(layer)) {
    return `overridden by ${winnerLabel(winner)}`;
  }
  return `(from ${winnerLabel(winner)})`;
}
async function openConfigFlow(params, extraEntries = [], onExtraSelect) {
  const result = await openSelector(params, true, extraEntries);
  if (result.kind === "cancel") return;
  if (result.id === "display-all") {
    await openDisplayAll(params);
  } else if (extraEntries.some((e) => e.id === result.id)) {
    if (onExtraSelect) await onExtraSelect(result.id);
  } else {
    await openEditMode(params, result.id);
  }
}
function openSelector(params, includeDisplayAll = true, extraEntries = []) {
  const entries = buildSelectorEntries(params, includeDisplayAll, extraEntries);
  const { ctx } = params;
  return new Promise((resolve5, reject) => {
    const factory = (tui, theme, _keybindings, done) => {
      const component = createScopeSelector({
        title: params.label,
        subtitle: `Configure settings for ${params.label}`,
        entries,
        tui,
        theme,
        done(result) {
          done(void 0);
          resolve5(result);
        }
      });
      return component;
    };
    const shown = ctx.ui.custom(factory, {
      overlay: true,
      overlayOptions: modalOverlay()
    });
    if (shown && typeof shown.then === "function") {
      shown.then(
        () => resolve5({ kind: "cancel" }),
        (error) => reject(error)
      );
    }
  });
}
async function openEditMode(params, scope) {
  const values = params.layerValues(scope);
  let inspection = params.inspect();
  const fields = params.buildFields(values);
  const currentValues = { ...values };
  const dirtyKeys = /* @__PURE__ */ new Set();
  function valueNote(field) {
    const key2 = String(field.key);
    const winner = inspection.winners[key2];
    if (!winner || winner === scope) return void 0;
    if (dirtyKeys.has(key2)) return void 0;
    return layerValueNote(winner, scope);
  }
  const scopeLabel = EDIT_MODE_TITLES[scope] ?? scope;
  const sources = params.scopeSources();
  const sourceEntry = sources.find((s) => s.scope === scope);
  const subtitle = scope === "session" ? params.sessionNote : sourceEntry?.note ?? "";
  const editPathNote = scope === "env" ? "environment variables (read-only)" : scope === "defaults" ? "built-in defaults" : scope === "session" ? sourceEntry?.path ?? sourceEntry?.note ?? "" : sourceEntry?.exists && sourceEntry.path ? sourceEntry.path : sourceEntry?.note ?? "";
  const wrappedFields = fields.map((f) => ({
    ...f,
    valueNote: () => valueNote(f)
  }));
  let activeEditBody;
  async function saveEdit(tui, theme, done) {
    const confirmed = await new Promise((resolve5) => {
      const c = createConfirm(
        {
          message: [`Really save to ${scopeLabel}?`],
          confirmLabel: "Save",
          danger: false
        },
        resolve5,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(
        c,
        `Save to ${scopeLabel}`
      );
    });
    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }
    try {
      const res = await params.save(
        { ...currentValues },
        scope
      );
      if (res.created && scope === "project") {
        params.ctx.ui.notify(`Project config written to ${res.path}`, "info");
      }
      params.onSaved(currentValues);
      dirtyKeys.clear();
      done(void 0);
    } catch (err) {
      params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  async function discardEdit(tui, theme, done) {
    const confirmed = await new Promise((resolve5) => {
      const c = createConfirm(
        {
          message: ["Discard changes?"],
          confirmLabel: "Discard",
          danger: true
        },
        resolve5,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(c);
    });
    if (confirmed) {
      done(void 0);
    } else {
      activeEditBody?.dismissOverlay();
    }
  }
  async function resetEdit(tui, theme) {
    const scopeLabel2 = EDIT_MODE_TITLES[scope] ?? scope;
    const confirmed = await new Promise((resolve5) => {
      const c = createConfirm(
        {
          message: [`Really reset ${scopeLabel2} to defaults?`],
          confirmLabel: "Reset",
          danger: true
        },
        resolve5,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(c);
    });
    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }
    try {
      await params.resetScope(scope);
      const fresh = params.layerValues(scope);
      for (const key2 of Object.keys(currentValues)) delete currentValues[key2];
      Object.assign(currentValues, fresh);
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  async function deleteEdit(tui, theme) {
    const scopeLabel2 = EDIT_MODE_TITLES[scope] ?? scope;
    const confirmed = await new Promise((resolve5) => {
      const c = createConfirm(
        {
          message: [`Really delete the ${scopeLabel2} config file?`],
          confirmLabel: "Delete",
          danger: true
        },
        resolve5,
        { tui, theme }
      );
      (activeEditBody ?? {}).mountOverlay(c);
    });
    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }
    try {
      await params.deleteScope(scope);
      if ((scope === "global" || scope === "project") && params.scopeSources().find((source) => source.scope === scope)?.exists) {
        throw new Error(`Failed to delete the ${scopeLabel2} config file.`);
      }
      const fresh = params.layerValues(scope);
      for (const key2 of Object.keys(currentValues)) delete currentValues[key2];
      Object.assign(currentValues, fresh);
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  const handlers = {
    onChange(key2, value) {
      currentValues[key2] = value;
      dirtyKeys.add(key2);
      params.onChange?.(key2, value);
    },
    onSave(tui, theme, done) {
      return saveEdit(tui, theme, done);
    },
    onRequestExit(tui, theme, done) {
      return discardEdit(tui, theme, done);
    },
    onAction(id, tui, theme, done) {
      switch (id) {
        case "save":
          void saveEdit(tui, theme, done).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
        case "discard":
          void discardEdit(tui, theme, done).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
        case "reset":
          void resetEdit(tui, theme).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
        case "delete":
          void deleteEdit(tui, theme).catch(
            (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
          );
          break;
      }
    }
  };
  await params.ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const body = createSettingsModalBody(
        {
          title: `${params.label} \u2014 ${scopeLabel}`,
          fields: wrappedFields,
          mode: "buffered",
          closeOnSave: false,
          enableSearch: true,
          pathNote: editPathNote,
          actions: scope === "session" ? [
            { id: "save", label: "Save" },
            { id: "discard", label: "Discard" },
            { id: "reset", label: "Reset", danger: true }
          ] : [
            { id: "save", label: "Save" },
            { id: "discard", label: "Discard" },
            { id: "reset", label: "Reset", danger: true },
            { id: "delete", label: "Delete", danger: true }
          ],
          onSave: () => handlers.onSave(tui, theme, done),
          onChange: handlers.onChange,
          onRequestExit: () => handlers.onRequestExit(tui, theme, done),
          onAction: (id) => handlers.onAction(id, tui, theme, done)
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(void 0)
        }
      );
      activeEditBody = body;
      return body;
    },
    { overlay: true, overlayOptions: modalOverlay() }
  );
}
async function openDisplayAll(params) {
  const inspection = params.inspect();
  const sources = params.scopeSources();
  const tabDefs = [];
  if (params.scopes.global !== false) {
    tabDefs.push({ id: "global", scope: "global", label: "Global" });
  }
  if (params.scopes.project !== false) {
    tabDefs.push({ id: "project", scope: "project", label: "Project Local" });
  }
  if (params.env && Object.keys(params.env).length > 0) {
    tabDefs.push({ id: "env", scope: "env", label: "Env" });
  }
  if (params.scopes.session && params.sessionInitialized) {
    tabDefs.push({ id: "session", scope: "session", label: "Session" });
  }
  tabDefs.push({ id: "defaults", scope: "defaults", label: "Defaults" });
  const subtitle = sources.map((s) => `${s.label}: ${s.note}`).join("\n");
  const tabPathNotes = {};
  for (const source of sources) {
    if (source.scope === "session") {
      tabPathNotes["session"] = source.path ?? source.note;
    } else {
      tabPathNotes[source.scope] = source.exists && source.path ? source.path : source.note;
    }
  }
  tabPathNotes["env"] = "environment variables (read-only)";
  tabPathNotes["defaults"] = "built-in defaults";
  const tabFields = {};
  for (const tab of tabDefs) {
    let layerVals;
    if (tab.scope === "defaults") {
      layerVals = { ...params.defaults };
    } else {
      layerVals = params.layerValues(tab.scope);
    }
    const raw = params.buildFields(layerVals);
    tabFields[tab.id] = raw.map((f) => ({
      ...f,
      tab: tab.id,
      valueNote: displayValueNote(f, tab.id, inspection, params.env)
    }));
  }
  let currentTabId = tabDefs[0].id;
  const allFields = tabDefs.flatMap((tab) => tabFields[tab.id] ?? []);
  await params.ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const pathNoteRef = { current: tabPathNotes[currentTabId] };
      const body = createSettingsModalBody(
        {
          title: params.label,
          tabs: tabDefs.map((t) => ({ id: t.id, label: t.label })),
          initialTab: currentTabId,
          fields: allFields,
          readOnly: true,
          pathNote: pathNoteRef.current,
          actions: [
            { id: "edit", label: "Edit" },
            { id: "cancel", label: "Cancel" }
          ],
          onAction(id) {
            switch (id) {
              case "cancel":
                queueMicrotask(() => done(void 0));
                break;
              case "edit":
                queueMicrotask(() => done(void 0));
                const isEditableScope = currentTabId === "global" && params.scopes.global || currentTabId === "project" && params.scopes.project || currentTabId === "session" && params.scopes.session;
                if (isEditableScope) {
                  void openEditMode(params, currentTabId).catch(
                    (err) => params.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error")
                  );
                } else {
                  void openSelector(params, false).then((result) => {
                    if (result.kind === "cancel") {
                      return openDisplayAll(params);
                    }
                    if (result.id !== "display-all") {
                      return openEditMode(params, result.id);
                    }
                    return void 0;
                  }).catch(
                    (err) => params.ctx.ui.notify(
                      err instanceof Error ? err.message : String(err),
                      "error"
                    )
                  );
                }
                break;
            }
          },
          onActiveTabChange(tabId) {
            currentTabId = tabId;
            pathNoteRef.current = tabPathNotes[tabId] ?? "";
          }
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(void 0)
        }
      );
      return body;
    },
    {
      overlay: true,
      overlayOptions: modalOverlay()
    }
  );
}
function displayValueNote(field, tabId, inspection, env) {
  const key2 = String(field.key);
  const winner = inspection.winners[key2];
  if (tabId === "env" && env?.[key2]) {
    const def = env[key2];
    const envWins = winner === "env";
    if (typeof def === "string") {
      const isSet2 = !!process.env[def]?.trim();
      if (!isSet2) return `(${def}: unset)`;
      return envWins ? `(${def}) \u25B8 effective` : `(${def})`;
    }
    const isSet = !!process.env[def.var]?.trim();
    if (!isSet) return `(${def.var}: unset)`;
    return envWins ? `(${def.var}) \u25B8 effective` : `(${def.var})`;
  }
  if (winner === tabId) return "\u25B8 effective";
  if (!winner) return void 0;
  return layerValueNote(winner, tabId);
}
function modalOverlay() {
  return { anchor: "center", width: "92%", maxHeight: "95%" };
}
var SCOPE_IDS, SCOPE_LABELS, EDIT_MODE_TITLES, SELECTOR_ENTRY_LABELS, LAYER_PRECEDENCE;
var init_config_flow = __esm({
  "modules/blackhole/src/pi-base/settings/config-flow.ts"() {
    "use strict";
    init_confirm();
    init_scope_selector();
    init_body();
    SCOPE_IDS = ["global", "project", "session"];
    SCOPE_LABELS = {
      global: "Global",
      project: "Project Local",
      env: "env",
      session: "Session",
      defaults: "default"
    };
    EDIT_MODE_TITLES = {
      global: "Global",
      project: "Project Local",
      session: "Session"
    };
    SELECTOR_ENTRY_LABELS = {
      global: "Configure Global settings",
      project: "Configure Project local settings",
      session: "Configure Session settings"
    };
    LAYER_PRECEDENCE = {
      session: 0,
      env: 1,
      project: 2,
      global: 3,
      defaults: 4
    };
  }
});

// modules/blackhole/src/pi-base/config-manager.ts
import { join as join8, resolve as resolve3 } from "node:path";
import { existsSync as existsSync6 } from "node:fs";
var ConfigManager;
var init_config_manager = __esm({
  "modules/blackhole/src/pi-base/config-manager.ts"() {
    "use strict";
    init_session();
    init_project_trust();
    init_config_env2();
    init_config();
    init_config_flow();
    init_validate_field();
    ConfigManager = class {
      opts;
      _sessionId;
      _leafId;
      _entries;
      _appendEntry;
      _getEntries;
      _filename;
      // Pending-mode session persistence state
      _sessionPersist = "unavailable";
      _sessionManager;
      _pendingCwd;
      _defaultConfigDir;
      _hostBinding;
      _hostSnapshot;
      _notifiedWarnings = globalThis[/* @__PURE__ */ Symbol.for("pi-blackhole:settings-warning-dedup")] ??= /* @__PURE__ */ new Set();
      constructor(opts) {
        this.opts = opts;
        this._defaultConfigDir = opts.configDir;
        if (!opts.filename && !opts.id) {
          throw new Error(
            "ConfigManager requires either `id` or `filename` in options. Provide one so the config file can be resolved."
          );
        }
        this._filename = opts.filename ?? `${opts.id}-config.json`;
      }
      /** Resolved scope availability (opts.scopes with defaults applied). */
      getScopes() {
        const s = this.opts.scopes ?? { global: true, project: true, session: true };
        return {
          global: s.global !== false,
          project: s.project !== false,
          session: s.session !== false && this.opts.sessionConfig !== false
        };
      }
      /** True when session config scope is available (persisted or pending). */
      hasSession() {
        return this._sessionPersist === "persisted" || this._sessionPersist === "pending";
      }
      /**
       * Lazily detect and initialize session state from the live context.
       *
       * Persistence states:
       * - "persisted": JSONL exists, leafId known, appendEntry available.
       *   Session config is keyed to the real leafId and appended to JSONL on save.
       * - "pending": session file path is known but not yet persistable
       *   (file missing, leafId null, or appendEntry absent). Session scope is
       *   available; saves go to the in-memory store under PENDING_SENTINEL.
       *   _tryFlushSession() migrates the pending config to the real leafId
       *   exactly once once the session file materializes.
       * - "unavailable": inMemory session or session opt-out. Session scope
       *   is hidden from the selector.
       *
       * Identity change guard: if we already hold session state for a DIFFERENT
       * sessionId (user switched sessions in-process), reset persistence state
       * and re-detect for the new session.
       */
      _ensureSession(ctx, cwd) {
        if (typeof ctx.sessionManager?.getBranch === "function" && typeof ctx.sessionManager?.getCwd === "function") {
          const sm2 = ctx.sessionManager;
          const mutable2 = sm2;
          const append = this._hostBinding?.appendEntry ?? ((type, data) => mutable2.appendCustomEntry(type, data));
          this.resolveHostSession(this.opts.defaults, ctx, append);
          this._tryFlushSession(cwd);
          return this.hasSession();
        }
        if (this._sessionManager && this._sessionId) {
          const currentSessionId = ctx.sessionManager?.getSessionId?.();
          if (currentSessionId && this._sessionId !== currentSessionId) {
            const oldSessionId = this._sessionId;
            const oldPendingCwd = this._pendingCwd ?? process.cwd();
            clearSessionConfig(this._getEntryType(), oldPendingCwd, oldSessionId, PENDING_SENTINEL);
            this._sessionId = void 0;
            this._leafId = void 0;
            this._entries = void 0;
            this._appendEntry = void 0;
            this._getEntries = void 0;
            this._sessionPersist = "unavailable";
            this._sessionManager = void 0;
            this._pendingCwd = void 0;
          }
        }
        if (this._sessionPersist === "persisted" && !this._sessionManager) {
          this._tryFlushSession(cwd);
          return true;
        }
        if (this._sessionPersist !== "unavailable" && this._sessionManager) {
          const sm2 = ctx.sessionManager;
          if (!sm2) {
            return true;
          }
          this._tryFlushSession(cwd);
          return true;
        }
        const sm = ctx.sessionManager;
        if (!sm) {
          this._sessionPersist = "unavailable";
          return false;
        }
        if (this.opts.scopes?.session === false || this.opts.sessionConfig === false) {
          this._sessionPersist = "unavailable";
          return false;
        }
        const file = sm.getSessionFile?.();
        if (typeof file !== "string") {
          this._sessionPersist = "unavailable";
          return false;
        }
        const leafId = sm.getLeafId?.() ?? null;
        const mutable = sm;
        const hasAppend = typeof mutable.appendCustomEntry === "function";
        const persistable = existsSync6(file) && leafId != null && hasAppend;
        if (persistable) {
          const appendEntryFn2 = (type, data) => {
            mutable.appendCustomEntry(type, data);
          };
          this.initSession(
            sm.getSessionId(),
            leafId,
            sm.getEntries?.() ?? [],
            appendEntryFn2,
            () => sm.getEntries?.()
          );
          this._sessionPersist = "persisted";
          this._sessionManager = mutable;
          this._pendingCwd = cwd;
          return true;
        }
        const appendEntryFn = hasAppend ? (type, data) => {
          mutable.appendCustomEntry(type, data);
        } : void 0;
        this._sessionId = sm.getSessionId() ?? void 0;
        this._leafId = PENDING_SENTINEL;
        this._entries = sm.getEntries?.();
        this._appendEntry = appendEntryFn;
        this._getEntries = () => sm.getEntries?.() ?? [];
        this._sessionPersist = "pending";
        this._sessionManager = mutable;
        this._pendingCwd = cwd;
        this._tryFlushSession(cwd);
        return true;
      }
      /**
       * Attempt to flush pending session config to the session JSONL.
       *
       * Only acts when _sessionPersist === "pending". The flush reads the
       * pending config from the in-memory store (keyed under PENDING_SENTINEL),
       * writes it to the real leafId via setSessionConfig, APPENDS a single
       * custom entry to the JSONL via appendCustomEntry, clears the sentinel
       * key, and transitions to persisted. Returns true only when an append
       * actually occurred (so callers can fall back to their own append when
       * flush transitioned without content).
       *
       * NEVER reads/scans the JSONL (existsSync only). The appended entry
       * uses appendCustomEntry which creates "custom" entries excluded from
       * LLM context. appendCustomMessageEntry is never used.
       *
       * Side-effect-on-read: called from _ensureSession (via load/openSettings)
       * so that config is appended to JSONL as soon as the session file
       * materializes — even without an explicit user save.
       *
       * The exactly-once guard is the _sessionPersist transition: once
       * "persisted", subsequent calls return immediately.
       *
       * @param cwd Working directory for the pending store key. Callers pass
       *   their resolved cwd (save passes its explicit targetCwd;
       *   loadWithWarnings/layerValues pass their cwd; _ensureSession passes
       *   its detection cwd).
       */
      _tryFlushSession(cwd) {
        if (this._sessionPersist !== "pending") return false;
        if (!this._sessionManager) return false;
        const sm = this._sessionManager;
        const hasAppend = typeof sm.appendCustomEntry === "function";
        const appendEntryFn = hasAppend ? (type, data) => {
          sm.appendCustomEntry(type, data);
        } : void 0;
        this._appendEntry = appendEntryFn;
        const file = sm.getSessionFile();
        if (typeof file !== "string" || !existsSync6(file)) return false;
        const leaf = sm.getLeafId();
        if (leaf == null) return false;
        if (!appendEntryFn) return false;
        const targetCwd = cwd ?? this._pendingCwd ?? process.cwd();
        const pendingConfig = getRawSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL) ?? {};
        if (Object.keys(pendingConfig).length > 0) {
          appendEntryFn(this._getEntryType(), { leafId: leaf, config: pendingConfig });
          setSessionConfig(this._getEntryType(), targetCwd, this._sessionId, leaf, pendingConfig);
          clearSessionConfig(this._getEntryType(), targetCwd, this._sessionId, PENDING_SENTINEL);
        }
        this._leafId = leaf;
        this._sessionPersist = "persisted";
        return Object.keys(pendingConfig).length > 0;
      }
      initSession(sessionId, leafId, entries, appendEntry2, getEntries) {
        if (this.opts.scopes?.session === false || this.opts.sessionConfig === false) return;
        this._hostBinding = void 0;
        this._sessionId = sessionId;
        this._leafId = leafId;
        this._entries = entries;
        this._appendEntry = appendEntry2;
        this._getEntries = getEntries;
        this._sessionPersist = "persisted";
        this._sessionManager = void 0;
        this._pendingCwd = void 0;
        const entryType = this._getEntryType(), chain = getAncestorChain(entries, leafId);
        for (const id of chain) {
          const entry = entries.find((e) => e.type !== "session" && e.id === id);
          if (entry?.type !== "custom" || entry.customType !== entryType) continue;
          const data = entry.data;
          const position = chain.indexOf(id);
          if (typeof data?.leafId === "string" && chain.indexOf(data.leafId) > position && typeof data.config === "object" && data.config !== null && !Array.isArray(data.config)) {
            setSessionConfig(entryType, process.cwd(), sessionId, id, data.config);
            break;
          }
        }
      }
      /**
       * Load config with layered resolution:
       *   defaults ← global file ← project file ← env overrides
       *
       * @param cwd Working directory for project-local override
       * @param configDir Global config directory (defaults to getExtensionsDir())
       */
      load(cwd, configDir) {
        return this.loadWithWarnings(cwd, configDir).config;
      }
      /**
       * Load config with warnings. Same as `load()` but also returns per-field
       * validation warnings and unknown-key warnings discovered during loading.
       *
       * Extensions that open a modal can surface these warnings in the UI;
       * extensions that load config programmatically can log or inspect them.
       */
      loadWithWarnings(cwd, configDir) {
        const warnings = [];
        const loaded = loadConfig(this._filename, this.opts.defaults, {
          cwd,
          configDir: configDir ?? this._defaultConfigDir,
          merge: "deep"
        });
        const config2 = this.opts.validate ? this.opts.validate(loaded, "file") : loaded;
        try {
          const fields = this.opts.fields(config2);
          const scope = "global";
          for (const field of fields) {
            if (field.type === "action" || field.type === "custom") continue;
            const warning = validateFieldValue(field, field.value);
            if (warning) {
              warnings.push({
                scope,
                key: String(field.key),
                message: `"${field.label}": ${warning}`
              });
            }
          }
        } catch {
        }
        const withEnv = this.applyEnvOverrides(config2);
        const scopes = this.opts.scopes ?? { global: true, project: true, session: true };
        const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
        const namespace = this._getEntryType();
        const final = sessionEnabled ? this.applySessionOverrides(withEnv, cwd, namespace) : withEnv;
        this._tryFlushSession(cwd);
        if (this.opts.diagnostics) {
          const { layers } = this.inspect(cwd, configDir);
          const messages = this.opts.diagnostics({ ...layers.global, ...layers.project, ...layers.env, ...layers.session });
          for (const message of new Set(messages)) warnings.push({ scope: "global", message });
        }
        return { config: final, warnings };
      }
      applyEnvOverrides(config2) {
        const base = this.opts.envBase?.(config2) ?? config2;
        const env = this.opts.env;
        if (!env) return base;
        return applyEnvOverrides2(
          base,
          env,
          this.opts.defaults
        );
      }
      applySessionOverrides(config2, cwd, namespace) {
        if (this._hostBinding) {
          const session3 = this._hostSessionOverrides(cwd);
          const merged2 = deepMerge(config2, session3);
          return this._applyValidation(merged2, "effective");
        }
        const sessionId = this._sessionId;
        const leafId = this._leafId;
        const entries = this._getEntries?.() ?? this._entries;
        if (!sessionId || !leafId || !entries) return config2;
        let session2;
        if (leafId === PENDING_SENTINEL) {
          session2 = getRawSessionConfig(namespace, cwd ?? process.cwd(), sessionId, PENDING_SENTINEL) ?? {};
        } else {
          session2 = getSessionConfig(namespace, cwd ?? process.cwd(), sessionId, leafId, entries);
        }
        const merged = deepMerge(
          config2,
          session2
        );
        return this.opts.validate ? this.opts.validate(merged) : merged;
      }
      _applyValidation(config2, phase = "file") {
        return this.opts.validate ? this.opts.validate(config2, phase) : config2;
      }
      /** Repeated load/reload may return diagnostics; notify once per session/message. */
      notifyWarnings(result, notify) {
        if (typeof notify !== "function") return;
        for (const warning of result.warnings) {
          const key2 = `${this.opts.id ?? this._filename}:${this._hostBinding?.cwd ?? this._pendingCwd ?? process.cwd()}:${this._sessionId ?? "uninitialized"}:${warning.message}`;
          if (this._notifiedWarnings.has(key2)) continue;
          try {
            notify(warning.message);
          } catch {
            continue;
          }
          this._notifiedWarnings.add(key2);
          while (this._notifiedWarnings.size > 512) this._notifiedWarnings.delete(this._notifiedWarnings.values().next().value);
        }
      }
      /** Bind the public readonly host projection; keep the unified file/env base.
       * No settings/config JSON is rewritten merely by startup, reload or navigation.
       */
      resolveHostSession(base, ctx, appendEntry2) {
        this._hostBinding = { sm: ctx.sessionManager, cwd: ctx.cwd, appendEntry: appendEntry2 };
        this._hostSessionOverrides(ctx.cwd);
        const diagnostics = this.loadWithWarnings(ctx.cwd);
        if (ctx.hasUI === true && typeof ctx.ui?.notify === "function") this.notifyWarnings(diagnostics, (message) => ctx.ui.notify(message, "warning"));
        return this.applySessionOverrides(base, ctx.cwd, this._getEntryType());
      }
      /** One synchronous public snapshot; persisted cache/pre-save coordinates are
       * never authority. Failure detaches all old state and returns the file/env base.
       */
      _hostSessionOverrides(cwd) {
        const binding = this._hostBinding;
        this._sessionId = void 0;
        this._leafId = void 0;
        this._entries = void 0;
        this._appendEntry = void 0;
        this._getEntries = void 0;
        this._sessionManager = void 0;
        this._sessionPersist = "unavailable";
        this._pendingCwd = void 0;
        this._hostSnapshot = void 0;
        if (!binding || this.opts.scopes?.session === false || this.opts.sessionConfig === false) return {};
        try {
          const { sm } = binding, owner = sm.getCwd(), id = sm.getSessionId(), file = sm.getSessionFile(), leaf = sm.getLeafId();
          const branch = sm.getBranch(), entries = sm.getEntries();
          if (resolve3(cwd ?? process.cwd()) !== resolve3(binding.cwd) || resolve3(owner) !== resolve3(binding.cwd) || !id || typeof file !== "string" || !Array.isArray(branch) || !Array.isArray(entries)) return {};
          const byId = /* @__PURE__ */ new Map();
          for (const entry of entries) {
            if (byId.has(entry.id)) return {};
            byId.set(entry.id, entry);
          }
          const seen = /* @__PURE__ */ new Set();
          let parent = null, overrides = {}, latestSettings;
          for (const entry of branch) {
            if (typeof entry.id !== "string" || seen.has(entry.id) || entry.parentId !== parent || !deepEqual(byId.get(entry.id), entry)) return {};
            if (entry.type === "custom" && entry.customType === this._getEntryType()) {
              const data = entry.data;
              if (typeof data?.leafId === "string" && seen.has(data.leafId) && typeof data.config === "object" && data.config !== null && !Array.isArray(data.config)) {
                overrides = structuredClone(data.config);
                latestSettings = entry;
              }
            }
            seen.add(entry.id);
            parent = entry.id;
          }
          if ((leaf ?? null) !== parent) return {};
          this._hostSnapshot = { sessionId: id, cwd: binding.cwd, file, leafId: leaf ?? null, latestSettings };
          this._sessionId = id;
          this._pendingCwd = binding.cwd;
          this._entries = branch;
          this._getEntries = () => sm.getBranch();
          this._appendEntry = binding.appendEntry;
          this._sessionManager = { getSessionFile: () => sm.getSessionFile(), getLeafId: () => sm.getLeafId(), getSessionId: () => sm.getSessionId(), getEntries: () => sm.getEntries(), appendCustomEntry: (type, data) => {
            binding.appendEntry(type, data);
            return "";
          } };
          const queued = getRawSessionConfig(this._getEntryType(), binding.cwd, id, PENDING_SENTINEL);
          const pending = queued && Object.keys(queued).length > 0 ? queued : void 0;
          const persisted = existsSync6(file) && typeof leaf === "string" && !pending;
          this._sessionPersist = persisted ? "persisted" : "pending";
          this._leafId = persisted ? leaf : PENDING_SENTINEL;
          return pending ?? (persisted ? overrides : {});
        } catch {
          return {};
        }
      }
      /**
       * Return merged config values up to and including the given scope.
       *
       * Composition:
       *   "global"  = defaults ← global file
       *   "project" = layerValues("global") ← project file
       *   "env"     = layerValues("project") ← env overrides
       *   "session" = layerValues("env") ← session store
       */
      layerValues(scope, cwd, configDir) {
        const dir2 = configDir ?? this._defaultConfigDir ?? getExtensionsDir();
        const defaults = this.opts.defaults;
        let result = { ...defaults };
        const globalData = readConfig(this._filename, dir2) ?? {};
        result = deepMerge(result, globalData);
        if (scope === "global") {
          return this._applyValidation(result);
        }
        if (cwd && isProjectLayerAdmitted(cwd)) {
          const projectDir = join8(cwd, ".pi");
          const projectData = readConfig(this._filename, projectDir) ?? {};
          result = deepMerge(result, projectData);
        }
        if (scope === "project" && !cwd) {
          throw new Error("cwd is required for project-scoped layerValues");
        }
        if (scope === "project") {
          return this._applyValidation(result);
        }
        result = this.applyEnvOverrides(this._applyValidation(result));
        if (scope === "env") {
          return this._applyValidation(result, "effective");
        }
        const scopes = this.opts.scopes ?? { global: true, project: true, session: true };
        const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
        const namespace = this._getEntryType();
        if (sessionEnabled) {
          const sessionResult = this.applySessionOverrides(result, cwd, namespace);
          result = sessionResult;
        }
        this._tryFlushSession(cwd);
        return this._applyValidation(result, "effective");
      }
      /**
       * Patch only the named keys of one persisted file (global or project). Unlike `save`, nothing is
       * derived from the merged effective config, so defaults/project/env values never leak into the target
       * file. Throws when the write fails.
       */
      patchScope(patch, scope, cwd, configDir) {
        if (scope === "project" && !cwd) throw new Error("cwd is required for project-scoped config patch");
        const dir2 = scope === "project" ? join8(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
        const targetPath = join8(dir2, this._filename);
        const existing = readConfig(this._filename, dir2) ?? {};
        const next = { ...existing, ...patch };
        const merged = this.opts.canonicalizePersisted?.(next) ?? next;
        if (deepEqual(merged, existing)) return { path: targetPath, changed: false };
        if (!writeConfig(this._filename, merged, dir2)) {
          throw new Error(`Failed to save ${this._filename} \u2014 the config file may be read-only (e.g., managed by Nix).`);
        }
        return { path: targetPath, changed: true };
      }
      /**
       * Inspect per-layer contributions and per-key winners.
       */
      inspect(cwd, configDir) {
        const dir2 = configDir ?? this._defaultConfigDir ?? getExtensionsDir();
        const defaultsLayer = { ...this.opts.defaults };
        const globalLayer = readConfig(this._filename, dir2) ?? {};
        const projectLayer = cwd && isProjectLayerAdmitted(cwd) ? readConfig(this._filename, join8(cwd, ".pi")) ?? {} : {};
        const envLayer = {};
        const beforeEnv = this._applyValidation(deepMerge(deepMerge({ ...defaultsLayer }, globalLayer), projectLayer));
        const envBase = this.opts.envBase?.(beforeEnv) ?? beforeEnv;
        for (const key2 of Object.keys(envBase)) if (!deepEqual(envBase[key2], beforeEnv[key2])) envLayer[key2] = envBase[key2];
        if (this.opts.env) {
          const envApplied = applyEnvOverrides2(
            envBase,
            this.opts.env,
            this.opts.defaults
          );
          const envRecord = envApplied;
          for (const [key2, value] of Object.entries(
            this.opts.env
          )) {
            if (this._envKeyIsActive(key2, value, this.opts.defaults)) {
              envLayer[key2] = envRecord[key2];
            }
          }
        }
        const sessionLayer = {};
        const scopes = this.opts.scopes ?? { global: true, project: true, session: true };
        const sessionEnabled = this.opts.sessionConfig !== false && scopes.session !== false;
        const namespace = this._getEntryType();
        if (sessionEnabled && this._hostBinding) {
          Object.assign(sessionLayer, this._hostSessionOverrides(cwd));
        } else if (sessionEnabled && this._sessionId && this._leafId) {
          let sessionConfig;
          if (this._leafId === PENDING_SENTINEL) {
            sessionConfig = getRawSessionConfig(namespace, cwd ?? process.cwd(), this._sessionId, PENDING_SENTINEL) ?? {};
          } else {
            sessionConfig = getSessionConfig(
              namespace,
              cwd ?? process.cwd(),
              this._sessionId,
              this._leafId,
              this._getEntries?.() ?? this._entries ?? []
            );
          }
          Object.assign(sessionLayer, sessionConfig);
        }
        const layers = {
          defaults: defaultsLayer,
          global: globalLayer,
          project: projectLayer,
          env: envLayer,
          session: sessionLayer
        };
        const allKeys = /* @__PURE__ */ new Set();
        for (const layer of Object.values(layers)) {
          for (const key2 of Object.keys(layer)) {
            allKeys.add(key2);
          }
        }
        const winners = {};
        const precedence = ["session", "env", "project", "global", "defaults"];
        for (const key2 of allKeys) {
          for (const layer of precedence) {
            if (key2 in layers[layer]) {
              winners[key2] = layer;
              break;
            }
          }
        }
        return { layers, winners };
      }
      /**
       * Return provenance sources for enabled scopes.
       */
      scopeSources(cwd, configDir) {
        const sources = [];
        const scopes = this.opts.scopes ?? { global: true, project: true, session: true };
        if (scopes.global !== false) {
          const globalDir = configDir ?? this._defaultConfigDir ?? getExtensionsDir();
          const globalPath = join8(globalDir, this._filename);
          const globalExists = existsSync6(globalPath);
          sources.push({
            scope: "global",
            label: "Global",
            path: globalPath,
            exists: globalExists,
            note: globalExists ? globalPath : "(nonexistent \u2014 will be created on save)"
          });
        }
        if (scopes.project !== false && cwd && isProjectLayerAdmitted(cwd)) {
          const projectPath = join8(cwd, ".pi", this._filename);
          const projectExists = existsSync6(projectPath);
          sources.push({
            scope: "project",
            label: "Project Local",
            path: projectPath,
            exists: projectExists,
            note: projectExists ? projectPath : "(nonexistent \u2014 will be created on save)"
          });
        }
        if (scopes.session !== false && this.opts.sessionConfig !== false) {
          const entryType = this._getEntryType();
          const sessionFile = this._sessionManager?.getSessionFile?.();
          const pending = this._sessionPersist === "pending";
          sources.push({
            scope: "session",
            label: "Session",
            exists: false,
            path: sessionFile,
            note: pending ? sessionFile ? `in-memory until session file exists \u2014 will persist automatically` : "in-memory until session file exists \u2014 will persist automatically" : `in-memory per-leaf overrides (persisted to session JSONL as ${entryType})`
          });
        }
        return sources;
      }
      _envKeyIsActive(key2, envValue, defaults) {
        if (typeof envValue === "string") {
          const raw = process.env[envValue]?.trim();
          if (!raw) return false;
          const defaultValue = defaults[key2];
          if (typeof defaultValue === "boolean") {
            return ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(raw.toLowerCase());
          }
          if (typeof defaultValue === "number") {
            if (Number.isInteger(defaultValue) && defaultValue > 0) {
              const parsed2 = Number.parseInt(raw, 10);
              return Number.isFinite(parsed2) && parsed2 > 0;
            }
            const parsed = Number.parseFloat(raw);
            return Number.isFinite(parsed);
          }
          return false;
        } else {
          const raw = process.env[envValue.var]?.trim();
          if (!raw) return false;
          try {
            return envValue.parse(raw, void 0) !== void 0;
          } catch {
            return false;
          }
        }
      }
      /**
       * Save config scoped to global or project directory.
       *
       * Writes only the fields that differ from the existing file content
       * (diff-based save against the file). This means:
       *
       * - **First save** (no file exists): writes ALL fields — the file is
       *   fully populated with every value the user confirmed.
       * - **Subsequent saves**: only the fields that actually changed in the
       *   current session are written. Everything else stays untouched.
       * - **Unknown keys** (hand-edited extras outside the schema) are
       *   automatically preserved by the read-patch-write cycle.
       * - **No read-time removal**: explicit saves may canonicalize proven ignored
       *   controls via canonicalizePersisted; reset/delete additionally removes keys.
       *
       * Reads the existing file, patches it with the deltas, and writes the
       * merged result. This prevents accidental overwrites of fields the user
       * never touched while keeping the file consistent with the UI.
       *
       * @param config Config to persist
       * @param scope Target scope
       * @param cwd Working directory (required for "project" scope)
       * @param configDir Override the global config dir (for tests)
       */
      save(config2, scope, cwd, configDir) {
        if (scope === "session") {
          config2 = this.opts.canonicalizePersisted?.(config2) ?? config2;
          if (this._hostBinding) this._hostSessionOverrides(cwd);
          if (!this._sessionId || !this._leafId) {
            throw new Error(
              "Cannot save session config: session not initialized. Call initSession() first."
            );
          }
          const targetCwd = cwd ?? process.cwd();
          setSessionConfig(
            this._getEntryType(),
            targetCwd,
            this._sessionId,
            this._leafId,
            config2
          );
          this._pendingCwd = targetCwd;
          const flushed = this._tryFlushSession(targetCwd);
          if (!flushed && this._sessionPersist === "persisted" && this._appendEntry) {
            this._appendEntry(this._getEntryType(), {
              leafId: this._leafId,
              config: config2
            });
          }
          return { path: "", created: false, changed: true };
        }
        if (scope === "project" && !cwd) {
          throw new Error("cwd is required for project-scoped config save");
        }
        const dir2 = scope === "project" && cwd ? join8(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
        const targetPath = join8(dir2, this._filename);
        const created = !existsSync6(targetPath);
        const knownKeys = new Set(Object.keys(this.opts.defaults));
        const existing = readConfig(this._filename, dir2) ?? {};
        const normalizedExisting = this.opts.canonicalizePersisted ? this._applyValidation(existing) : void 0;
        const fieldMap = /* @__PURE__ */ new Map();
        try {
          const fields = this.opts.fields(config2);
          for (const f of fields) fieldMap.set(String(f.key), f);
        } catch {
        }
        const diff = {};
        let hasDiff = false;
        for (const key2 of Object.keys(this.opts.defaults)) {
          const modalVal = config2[key2];
          const fileVal = existing[String(key2)];
          if (deepEqual(modalVal, fileVal)) continue;
          if (fileVal !== void 0 && normalizedExisting && deepEqual(modalVal, normalizedExisting[String(key2)])) continue;
          const field = fieldMap.get(String(key2));
          if (field && !(field.type === "action" || field.type === "custom")) {
            const warning = validateFieldValue(field, modalVal);
            if (warning) continue;
          }
          diff[String(key2)] = modalVal;
          hasDiff = true;
        }
        for (const [key2, val] of Object.entries(existing)) {
          if (!knownKeys.has(key2)) {
            diff[key2] = val;
            hasDiff = true;
          }
        }
        const merged = this.opts.canonicalizePersisted?.({ ...existing, ...diff }) ?? { ...existing, ...diff };
        if (!hasDiff && deepEqual(merged, existing)) {
          return { path: targetPath, created, changed: false };
        }
        const wrote = writeConfig(this._filename, merged, dir2);
        if (!wrote) {
          throw new Error(
            `Failed to save ${this._filename} \u2014 the config file may be read-only (e.g., managed by Nix). Runtime state was updated for this session only.`
          );
        }
        return { path: targetPath, created, changed: true };
      }
      /**
       * Open the settings modal with scope tabs, auto-generated onSave, etc.
       *
       * Before opening the modal, checks global and project-local config files
       * for malformed JSON. If either is invalid, a warning notification is
       * shown so the user knows their config couldn't be fully loaded.
       *
       * @param ctx Extension context
       * @param cwd Working directory for project-local override
       * @param onSave Called with the validated config after the user saves
       * @param configDir Override the global config dir (for tests)
       */
      _getEntryType() {
        if (typeof this.opts.sessionConfig === "object" && this.opts.sessionConfig.entryType) {
          return this.opts.sessionConfig.entryType;
        }
        return `session-config-${this.opts.id}`;
      }
      /**
       * Open the settings with the config flow (pre-selector →
       * edit mode / display-all).
       *
       * Signature is stable. Before opening, checks global and
       * project-local config files for malformed JSON and warns.
       *
       * The consumer's `onSave` is called with the validated config
       * after persist. Validation runs inside the save wrapper.
       *
       * @param ctx Extension context
       * @param cwd Working directory for project-local override
       * @param onSave Called with the validated config after the user saves
       * @param configDir Override the global config dir (for tests)
       * @param onChange Optional per-field change handler passed through
       */
      async openSettings(ctx, cwd, onSave, configDir, onChange, extraEntries, onExtraSelect) {
        configDir = configDir ?? this._defaultConfigDir;
        this.warnOnMalformedConfig(ctx, cwd, configDir);
        const scopes = this.getScopes();
        const sessionInitialized = this._ensureSession(ctx, cwd);
        if (ctx.hasUI === true && typeof ctx.ui?.notify === "function") this.notifyWarnings(this.loadWithWarnings(cwd, configDir), (message) => ctx.ui.notify(message, "warning"));
        const sources = this.scopeSources(cwd, configDir);
        await openConfigFlow(
          {
            label: this.opts.label,
            ctx,
            cwd,
            scopes,
            sessionInitialized,
            sessionNote: sources.find((s) => s.scope === "session")?.note ?? "",
            defaults: this.opts.defaults,
            env: this.opts.env,
            buildFields: (values) => {
              const fields = this.opts.fields(values);
              const configDefaults = this.opts.defaults;
              for (const field of fields) {
                if (field.type === "action" || field.type === "custom") continue;
                if (field.default === void 0) {
                  const key2 = String(field.key);
                  if (key2 in configDefaults) {
                    field.default = configDefaults[key2];
                  }
                }
              }
              return fields;
            },
            layerValues: (s) => this.layerValues(s, cwd, configDir),
            inspect: () => this.inspect(cwd, configDir),
            scopeSources: () => this.scopeSources(cwd, configDir),
            save: async (values, scope) => {
              const updated = this.opts.validate ? this.opts.validate(values) : values;
              const res = this.save(updated, scope, cwd, configDir);
              onSave(updated);
              return res;
            },
            resetScope: (scope) => this.resetScope(scope, cwd, configDir),
            deleteScope: (scope) => this.deleteScope(scope, cwd, configDir),
            onSaved: () => {
            },
            onChange
          },
          extraEntries,
          onExtraSelect
        );
      }
      /** Explicit host revocation is an append-only empty override, not cache erasure.
       * Pending is cleared only after a validated current-branch record acknowledges
       * the append. Failure preserves the old record and genuinely unsaved pending.
       */
      _revokeSession(cwd, action) {
        if (this._hostBinding) this._hostSessionOverrides(cwd);
        if (!this._sessionId || !this._leafId) throw new Error(`Cannot ${action} session config: session not initialized.`);
        const targetCwd = cwd ?? this._hostBinding?.cwd ?? process.cwd(), namespace = this._getEntryType();
        if (this._hostBinding) {
          const before = this._hostSnapshot;
          if (!before || !this._appendEntry) throw new Error(`Cannot ${action} session config: public owner unavailable.`);
          if (before.leafId !== null && existsSync6(before.file)) {
            this._appendEntry(namespace, { leafId: before.leafId, config: {} });
            this._hostSessionOverrides(targetCwd);
            const after = this._hostSnapshot, record = after?.latestSettings;
            const data = record?.type === "custom" ? record.data : void 0;
            if (after?.sessionId !== before.sessionId || after.cwd !== before.cwd || !record || record.id === before.leafId || data?.leafId !== before.leafId || !data.config || Object.keys(data.config).length !== 0) {
              throw new Error(`Cannot ${action} session config: append not verified on current branch.`);
            }
            clearSessionConfig(namespace, targetCwd, before.sessionId, PENDING_SENTINEL);
            this._hostSessionOverrides(targetCwd);
          } else {
            clearSessionConfig(namespace, targetCwd, before.sessionId, PENDING_SENTINEL);
          }
          return;
        }
        clearSessionConfig(namespace, targetCwd, this._sessionId, this._sessionPersist === "pending" ? PENDING_SENTINEL : this._leafId);
      }
      /**
       * Reset a scope's configuration to defaults. Known config keys
       * (those defined in the schema) are removed from the file; unknown
       * keys (from future versions or user additions) are preserved so
       * forward-compatibility is maintained. Next load will use defaults
       * for all known fields.
       *
       * After this call, the file contains only unknown keys. If no
       * unknown keys exist, the file is deleted entirely.
       */
      resetScope(scope, cwd, configDir) {
        if (scope === "session") {
          this._revokeSession(cwd, "reset");
          return;
        }
        if (scope === "project" && !cwd) {
          throw new Error("cwd is required for project-scoped config reset");
        }
        const dir2 = scope === "project" && cwd ? join8(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
        const knownKeys = new Set(Object.keys(this.opts.defaults));
        const existing = readConfig(this._filename, dir2);
        const unknownKeys = {};
        if (existing && typeof existing === "object") {
          for (const [key2, val] of Object.entries(existing)) {
            if (!knownKeys.has(key2)) unknownKeys[key2] = val;
          }
        }
        if (Object.keys(unknownKeys).length > 0) {
          writeConfig(this._filename, unknownKeys, dir2);
        } else {
          deleteConfig(this._filename, dir2);
        }
      }
      /**
       * Delete the entire config file for a scope. Unlike `resetScope`,
       * this removes unknown keys as well — the file is completely gone.
       * Next load will use nothing but defaults.
       */
      deleteScope(scope, cwd, configDir) {
        if (scope === "session") {
          this._revokeSession(cwd, "delete");
          return;
        }
        if (scope === "project" && !cwd) {
          throw new Error("cwd is required for project-scoped config delete");
        }
        const dir2 = scope === "project" && cwd ? join8(cwd, ".pi") : configDir ?? this._defaultConfigDir ?? getExtensionsDir();
        deleteConfig(this._filename, dir2);
      }
      /**
       * Check global and project-local config files for malformed JSON.
       * Warns via ctx.ui.notify if any are found.
       */
      warnOnMalformedConfig(ctx, cwd, configDir) {
        const filename = this._filename;
        const globalStatus = checkConfigFile(filename, configDir);
        if (globalStatus.exists && !globalStatus.valid) {
          ctx.ui.notify(
            `Config file "${filename}" is ${globalStatus.error}. Using defaults.`,
            "warning"
          );
        }
        if (!isProjectLayerAdmitted(cwd)) return;
        const projectDir = join8(cwd, ".pi");
        const projectStatus = checkConfigFile(filename, projectDir);
        if (projectStatus.exists && !projectStatus.valid) {
          ctx.ui.notify(
            `Project config file ".pi/${filename}" is ${projectStatus.error}. Using defaults.`,
            "warning"
          );
        }
      }
    };
  }
});

// modules/blackhole/src/changelog/changelog.ts
var changelog_exports = {};
__export(changelog_exports, {
  createChangelogViewer: () => createChangelogViewer,
  entriesToPlainLines: () => entriesToPlainLines,
  getOwnPackageRoot: () => getOwnPackageRoot,
  getPackageVersion: () => getPackageVersion,
  openChangelogView: () => openChangelogView,
  parseChangelogEntries: () => parseChangelogEntries,
  readChangelogText: () => readChangelogText,
  renderChangelogEntries: () => renderChangelogEntries,
  stripMarkdownInline: () => stripMarkdownInline
});
import { readFileSync as readFileSync6, existsSync as existsSync7 } from "node:fs";
import { dirname as dirname5, join as join9 } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesKey as matchesKey12 } from "@earendil-works/pi-tui";
function getOwnPackageRoot() {
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === "string" && metaUrl.length > 0) {
      let dir2 = dirname5(fileURLToPath(metaUrl));
      while (dir2 !== dirname5(dir2)) {
        try {
          const pkg = JSON.parse(readFileSync6(join9(dir2, "package.json"), "utf-8"));
          if (pkg.name === "pi-blackhole") return dir2;
        } catch {
        }
        const parent = dirname5(dir2);
        if (parent === dir2) break;
        dir2 = parent;
      }
    }
  } catch {
  }
  try {
    let dir2 = process.cwd();
    while (dir2 !== dirname5(dir2)) {
      try {
        const pkg = JSON.parse(readFileSync6(join9(dir2, "package.json"), "utf-8"));
        if (pkg.name === "pi-blackhole") return dir2;
      } catch {
      }
      const parent = dirname5(dir2);
      if (parent === dir2) break;
      dir2 = parent;
    }
  } catch {
  }
  try {
    const entry = process.argv[1];
    if (entry) {
      let dir2 = dirname5(entry);
      while (dir2 !== dirname5(dir2)) {
        try {
          const pkg = JSON.parse(readFileSync6(join9(dir2, "package.json"), "utf-8"));
          if (pkg.name === "pi-blackhole") return dir2;
        } catch {
        }
        const parent = dirname5(dir2);
        if (parent === dir2) break;
        dir2 = parent;
      }
    }
  } catch {
  }
  return process.cwd();
}
function getPackageVersion(packageRoot) {
  const root = packageRoot ?? getOwnPackageRoot();
  try {
    const pkg = JSON.parse(readFileSync6(join9(root, "package.json"), "utf-8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
  }
  return void 0;
}
function stripMarkdownInline(text) {
  let s = text;
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  return s;
}
function readChangelogText(packageRoot) {
  const explicitRoot = packageRoot !== void 0;
  const root = packageRoot ?? getOwnPackageRoot();
  const candidates = [join9(root, "CHANGELOG.md"), join9(root, "docs/CHANGELOG.md")];
  for (const p of candidates) {
    try {
      if (existsSync7(p)) return readFileSync6(p, "utf-8");
    } catch {
    }
  }
  if (explicitRoot) return void 0;
  try {
    const fallback = join9(process.cwd(), "docs/CHANGELOG.md");
    if (existsSync7(fallback)) return readFileSync6(fallback, "utf-8");
  } catch {
  }
  return BUNDLED_CHANGELOG_TEXT ?? void 0;
}
function parseChangelogEntries(text, maxEntries) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current;
  let currentSection;
  const versionRe = /^##\s+\[([^\]]+)\]\s*-?\s*(.*)\s*$/;
  const sectionRe = /^###\s+(.+)\s*$/;
  const bulletRe = /^\s*-\s+(.*)\s*$/;
  for (const raw of lines) {
    const versionMatch = raw.match(versionRe);
    if (versionMatch) {
      if (current) entries.push(current);
      current = {
        version: versionMatch[1].trim(),
        date: versionMatch[2].trim() || void 0,
        sections: []
      };
      currentSection = void 0;
      if (maxEntries !== void 0 && entries.length >= maxEntries) {
      }
      continue;
    }
    if (!current) continue;
    const sectionMatch = raw.match(sectionRe);
    if (sectionMatch) {
      currentSection = {
        heading: stripMarkdownInline(sectionMatch[1].trim()),
        items: []
      };
      current.sections.push(currentSection);
      continue;
    }
    const bulletMatch = raw.match(bulletRe);
    if (bulletMatch && currentSection) {
      currentSection.items.push(stripMarkdownInline(bulletMatch[1].trim()));
      continue;
    }
    if (currentSection && currentSection.items.length > 0 && raw.length > 0 && /^\s{2,}\S/.test(raw) && !raw.startsWith("##") && !raw.startsWith("###")) {
      const last = currentSection.items.length - 1;
      currentSection.items[last] = `${currentSection.items[last]} ${stripMarkdownInline(raw.trim())}`;
    }
  }
  if (current) entries.push(current);
  if (maxEntries !== void 0) return entries.slice(0, maxEntries);
  return entries;
}
function entriesToPlainLines(entries) {
  const out = [];
  for (const entry of entries) {
    const header = entry.date ? `## [${entry.version}] - ${entry.date}` : `## [${entry.version}]`;
    out.push(header);
    out.push("");
    if (entry.sections.length === 0) {
      out.push("(no details)");
      out.push("");
      continue;
    }
    for (const sec of entry.sections) {
      out.push(`### ${sec.heading}`);
      if (sec.items.length === 0) {
        out.push("(no items)");
      } else {
        for (const item of sec.items) {
          out.push(`- ${item}`);
        }
      }
      out.push("");
    }
  }
  return out;
}
function renderChangelogEntries(entries, width, theme) {
  const plain = entriesToPlainLines(entries);
  const wrapped = [];
  for (const line of plain) {
    if (line.startsWith("## [")) {
      const styled = theme.fg("accent", theme.bold(line));
      wrapped.push(...wrapLine(styled, width));
    } else if (line.startsWith("### ")) {
      wrapped.push(...wrapLine(theme.fg("accent", line), width));
    } else if (line.startsWith("- ")) {
      const chunks = wrapLine(line, width);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) wrapped.push(chunks[i]);
        else wrapped.push(`  ${chunks[i]}`);
      }
    } else if (line === "") {
      wrapped.push("");
    } else {
      wrapped.push(...wrapLine(line, width));
    }
  }
  return wrapped;
}
function createChangelogViewer(args) {
  const { tui, theme, done, packageRoot, maxEntries } = args;
  const version = getPackageVersion(packageRoot);
  const title = version ? `pi-blackhole v${version} \u2014 Changelog` : "pi-blackhole \u2014 Changelog";
  const raw = readChangelogText(packageRoot);
  let allLines;
  if (!raw) {
    allLines = ["Changelog not found.", "Expected CHANGELOG.md at package root."];
  } else {
    const entries = parseChangelogEntries(raw, maxEntries);
    if (entries.length === 0) {
      const stripped = raw.split(/\r?\n/).map((l) => stripMarkdownInline(l));
      allLines = stripped;
    } else {
      const entriesRef = entries;
      return createLazyChangelogViewer({
        tui,
        theme,
        done,
        title,
        entries: entriesRef
      });
    }
  }
  let scroll = 0;
  const PAGE = 5;
  const render = (width) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const cw = frameContentWidth(width);
    const wrapped = [];
    for (const line of allLines) {
      if (line === "") wrapped.push("");
      else wrapped.push(...wrapLine(line, cw));
    }
    const visible = Math.max(1, inner - 2);
    const maxScroll = Math.max(0, wrapped.length - visible);
    scroll = Math.min(scroll, maxScroll);
    const slice = wrapped.slice(scroll, scroll + visible);
    while (slice.length < visible) slice.push("");
    const body = [];
    if (scroll > 0) body.push(theme.fg("dim", `  \u2191 ${scroll} earlier`));
    body.push(...slice);
    if (scroll + visible < wrapped.length) {
      body.push(theme.fg("dim", `  \u2193 ${wrapped.length - scroll - visible} more`));
    }
    const hints = "\u2191\u2193 scroll \xB7 PgUp/PgDn \xB7 Esc close";
    const footer = theme.fg("dim", hints);
    const withFooter = [...body, "", footer];
    return frame(withFooter, width, theme, {
      title,
      fixedInnerRows: inner
    });
  };
  const handleInput = (data) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const cw = frameContentWidth(80);
    const wrapped = [];
    for (const line of allLines) {
      if (line === "") wrapped.push("");
      else wrapped.push(...wrapLine(line, cw));
    }
    const visible = Math.max(1, inner - 2);
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (matchesKey12(data, "up")) {
      scroll = Math.max(0, scroll - 1);
      tui.requestRender();
    } else if (matchesKey12(data, "down")) {
      scroll = Math.min(maxScroll, scroll + 1);
      tui.requestRender();
    } else if (matchesKey12(data, "pageUp")) {
      scroll = Math.max(0, scroll - PAGE);
      tui.requestRender();
    } else if (matchesKey12(data, "pageDown")) {
      scroll = Math.min(maxScroll, scroll + PAGE);
      tui.requestRender();
    } else if (matchesKey12(data, "escape") || matchesKey12(data, "ctrl+c")) {
      done();
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
function createLazyChangelogViewer(params) {
  const { tui, theme, done, title, entries } = params;
  let scroll = 0;
  const PAGE = 5;
  let lastWidth = 80;
  let cachedWrapped = [];
  function getWrapped(width) {
    if (width === lastWidth && cachedWrapped.length > 0) return cachedWrapped;
    lastWidth = width;
    const cw = frameContentWidth(width);
    cachedWrapped = renderChangelogEntries(entries, cw, theme);
    return cachedWrapped;
  }
  const render = (width) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const wrapped = getWrapped(width);
    const visible = Math.max(1, inner - 3);
    const maxScroll = Math.max(0, wrapped.length - visible);
    scroll = Math.min(scroll, maxScroll);
    const slice = wrapped.slice(scroll, scroll + visible);
    while (slice.length < visible) slice.push("");
    const body = [];
    if (scroll > 0) body.push(theme.fg("dim", `  \u2191 ${scroll} earlier`));
    body.push(...slice);
    if (scroll + visible < wrapped.length) {
      body.push(theme.fg("dim", `  \u2193 ${wrapped.length - scroll - visible} more`));
    }
    body.push("");
    body.push(theme.fg("dim", "  \u2191\u2193 scroll \xB7 PgUp/PgDn \xB7 Esc close"));
    return frame(body, width, theme, { title, fixedInnerRows: inner });
  };
  const handleInput = (data) => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS2, 14);
    const wrapped = getWrapped(lastWidth);
    const visible = Math.max(1, inner - 3);
    const maxScroll = Math.max(0, wrapped.length - visible);
    if (matchesKey12(data, "up")) {
      scroll = Math.max(0, scroll - 1);
      tui.requestRender();
    } else if (matchesKey12(data, "down")) {
      scroll = Math.min(maxScroll, scroll + 1);
      tui.requestRender();
    } else if (matchesKey12(data, "pageUp")) {
      scroll = Math.max(0, scroll - PAGE);
      tui.requestRender();
    } else if (matchesKey12(data, "pageDown")) {
      scroll = Math.min(maxScroll, scroll + PAGE);
      tui.requestRender();
    } else if (matchesKey12(data, "escape") || matchesKey12(data, "ctrl+c")) {
      done();
    }
  };
  return { render, handleInput, invalidate: () => {
  } };
}
async function openChangelogView(ctx) {
  await ctx.ui.custom(
    (tui, theme, _kb, done) => createChangelogViewer({ tui, theme, done: () => done(void 0) }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" }
    }
  );
}
var BUNDLED_CHANGELOG_TEXT, PREFERRED_INNER_ROWS2;
var init_changelog = __esm({
  "modules/blackhole/src/changelog/changelog.ts"() {
    "use strict";
    init_frame();
    BUNDLED_CHANGELOG_TEXT = void 0;
    PREFERRED_INNER_ROWS2 = 45;
  }
});

// modules/blackhole/src/pi-base/blackhole-settings.ts
var blackhole_settings_exports = {};
__export(blackhole_settings_exports, {
  GLOBAL_CONFIG_DIR: () => GLOBAL_CONFIG_DIR,
  config: () => config,
  openBlackholeSettings: () => openBlackholeSettings
});
import { join as join10 } from "node:path";
async function openBlackholeSettings(ctx) {
  await config.openSettings(
    ctx,
    ctx.cwd,
    (_updated) => {
    },
    GLOBAL_CONFIG_DIR,
    void 0,
    [
      {
        id: "changelog",
        label: "Display Changelog",
        available: true
      }
    ],
    async (id) => {
      if (id === "changelog") await openChangelogView(ctx);
    }
  );
}
var CONFIG_FILENAME, GLOBAL_CONFIG_DIR, config;
var init_blackhole_settings = __esm({
  "modules/blackhole/src/pi-base/blackhole-settings.ts"() {
    "use strict";
    init_config_manager();
    init_paths();
    init_config_env();
    init_unified_config();
    init_model_budget();
    init_changelog();
    init_pi_owned_settings();
    CONFIG_FILENAME = "pi-blackhole-config.json";
    GLOBAL_CONFIG_DIR = join10(getPiAgentDir(), "pi-blackhole");
    config = new ConfigManager({
      id: "pi-blackhole",
      label: "pi-blackhole",
      filename: CONFIG_FILENAME,
      configDir: GLOBAL_CONFIG_DIR,
      defaults: DEFAULTS,
      canonicalizePersisted: canonicalPersistedSettings,
      scopes: { global: true, project: true, session: true },
      sessionConfig: { entryType: "session-config-pi-blackhole" },
      fields: (cfg) => [
        // ── Compaction ──
        {
          key: "compaction",
          type: "enum",
          label: "Compaction mode",
          description: "auto=summary participation when Pi compacts; manual=only /blackhole; off=Pi summaries except explicit /blackhole. None disables Pi auto compaction.",
          value: cfg.compaction,
          options: ["auto", "manual", "off"],
          optionLabels: {
            auto: "auto \u2014 Pi-owned compaction, Blackhole summary",
            manual: "manual \u2014 only /blackhole",
            off: "off \u2014 auto:Pi handles, /blackhole:blackhole pipeline"
          }
        },
        {
          key: "compactionEngine",
          type: "enum",
          label: "Compaction engine",
          description: "blackhole=structured summary+OM, pi-default=Pi summary except explicit /blackhole; neither changes Pi timing or budgets",
          value: cfg.compactionEngine,
          options: ["blackhole", "pi-default"],
          optionLabels: {
            blackhole: "blackhole \u2014 structured summary + OM",
            "pi-default": "pi-default \u2014 built-in Pi summarization"
          }
        },
        {
          key: "compactionSummaryMode",
          type: "enum",
          label: "Summary history",
          description: "default=replace one complete summary, append=freeze automatic segments and rebase on /blackhole",
          value: cfg.compactionSummaryMode,
          options: ["default", "append"],
          optionLabels: {
            default: "default \u2014 one complete replacement summary",
            append: "append \u2014 immutable auto segments; /blackhole rebases"
          }
        },
        {
          key: "tailBehavior",
          type: "enum",
          label: "Visible tail",
          description: "Legacy ignored for Pi timing/cut. Native preparation controls retained context for every value.",
          value: cfg.tailBehavior,
          options: ["minimal", "pi-default"],
          optionLabels: {
            minimal: "minimal \u2014 legacy ignored",
            "pi-default": "pi-default \u2014 legacy ignored"
          }
        },
        {
          key: "midRunCompaction",
          type: "enum",
          label: "Mid-run compaction",
          description: "Legacy ignored for Pi timing/cut. Pi alone controls compaction and continuation.",
          value: cfg.midRunCompaction,
          options: ["resume", "pause", "off"],
          optionLabels: {
            resume: "resume \u2014 legacy ignored",
            pause: "pause \u2014 legacy ignored",
            off: "off \u2014 legacy ignored"
          }
        },
        {
          key: "showPreCompactionMessage",
          type: "boolean",
          label: "Show pre-compaction output",
          description: "Display-only copy (max 16 KiB) of the newest assistant output the compaction dropped. Never enters model context or memory.",
          value: cfg.showPreCompactionMessage,
          valueDescriptions: {
            on: "Shown \u2014 recent output re-rendered below the compaction card",
            off: "Hidden \u2014 compaction card only"
          }
        },
        {
          key: "compactAfterTokens",
          type: "number",
          label: "Auto-compact threshold (tokens)",
          description: "Legacy ignored for Pi timing/cut. Configure Pi compaction.enabled/reserveTokens/keepRecentTokens instead.",
          value: cfg.compactAfterTokens ?? 0,
          min: 0,
          max: 5e5,
          step: 1e3
        },
        {
          key: "retainedToolOutputMaxTokens",
          type: "number",
          label: "Retained tool outputs",
          description: "Legacy ignored for Pi timing/cut; no new tool-output pruning. Pi native preparation owns retained text.",
          value: cfg.retainedToolOutputMaxTokens,
          min: 1e3,
          max: 2e5,
          step: 1e3
        },
        // Context-window-derived knobs (issue #60) + preset curve (spec §4). Always
        // visible: 0 means "not set" (the loader treats 0 as unset, so the selected
        // preset curve governs). Type a value to engage the knob; set it back to 0
        // to turn it off. The tokens field above wins whenever it holds an explicit
        // non-zero value; ratio wins over reserve when both are set; the preset
        // select (below) picks the curve that applies when no numeric knob is set.
        {
          key: "compactAfterRatio",
          type: "number",
          label: "Auto-compact ratio (of context window)",
          description: "Legacy ignored for Pi timing/cut. This ratio does not initiate compaction.",
          value: cfg.compactAfterRatio ?? 0,
          min: 0,
          max: 1
        },
        {
          key: "compactReserveTokens",
          type: "number",
          label: "Auto-compact headroom reserve",
          description: "Legacy ignored for Pi timing/cut. This is not Pi's effective reserveTokens setting.",
          value: cfg.compactReserveTokens ?? 0,
          integer: true,
          min: 0,
          max: 2e6
        },
        {
          key: "compactAfterPreset",
          type: "enum",
          label: "Compaction threshold preset",
          description: "Legacy ignored for Pi timing/cut. Presets remain readable but do not select Pi budgets.",
          value: cfg.compactAfterPreset ?? "default",
          // Options = built-in preset names + any user-added names from the file
          // (same effective-presets merge the resolver uses, so the modal list and
          // runtime resolution cannot disagree).
          options: Object.keys(effectivePresets(cfg)),
          optionLabels: Object.fromEntries(
            Object.keys(effectivePresets(cfg)).map((name) => [
              name,
              name === "default" ? "default \u2014 legacy ignored" : `${name} (custom preset)`
            ])
          )
        },
        // ── Observational Memory ──
        {
          key: "memory",
          type: "boolean",
          label: "Observational memory",
          description: "Enable OM workers (observer, reflector, dropper) and content injection",
          value: cfg.memory,
          valueDescriptions: {
            on: "Active \u2014 OM workers + content injection enabled",
            off: "Suspended \u2014 OM disabled"
          }
        },
        {
          key: "sessionFallback",
          type: "boolean",
          label: "Session model fallback",
          description: "off=skip stage when all OM models fail, instead of falling back to the main coding model",
          value: cfg.sessionFallback ?? true
        },
        {
          key: "observeAfterTokens",
          type: "number",
          label: "Observer threshold",
          description: "Tokens accumulated since last observer run before triggering next observe",
          value: cfg.observeAfterTokens,
          min: 1e3,
          max: 2e5,
          step: 1e3
        },
        {
          key: "reflectAfterTokens",
          type: "number",
          label: "Reflect + dropper threshold",
          description: "Tokens accumulated since last reflect before triggering reflector and dropper",
          value: cfg.reflectAfterTokens,
          min: 1e3,
          max: 2e5,
          step: 1e3
        },
        {
          key: "observationsPoolMaxTokens",
          type: "number",
          label: "Observation pool max",
          description: "Full-fold pressure and max estimated rendered observation-line tokens in compaction output",
          value: cfg.observationsPoolMaxTokens,
          min: 1e3,
          max: 2e5,
          step: 1e3
        },
        {
          key: "reflectionsPoolMaxTokens",
          type: "number",
          label: "Reflection output max",
          description: "Max estimated rendered reflection-line tokens in compaction output. 0 disables the cap. Full source records remain available through recall.",
          value: cfg.reflectionsPoolMaxTokens,
          min: 0,
          max: 2e5,
          step: 1e3
        },
        {
          key: "observationsPoolTargetTokens",
          type: "number",
          label: "Observation pool target",
          description: "Target tokens after dropper prunes (defaults to half of pool max)",
          value: cfg.observationsPoolTargetTokens,
          min: 500,
          max: 2e5,
          step: 500
        },
        {
          key: "reflectorInputMaxTokens",
          type: "number",
          label: "Reflector input max",
          description: "Max prompt tokens for reflector model input (rolling window cap)",
          value: cfg.reflectorInputMaxTokens,
          min: 1e3,
          max: 5e5,
          step: 1e3
        },
        {
          key: "dropperInputMaxTokens",
          type: "number",
          label: "Dropper input max",
          description: "Max prompt tokens for dropper model input (rolling window cap)",
          value: cfg.dropperInputMaxTokens,
          min: 1e3,
          max: 5e5,
          step: 1e3
        },
        {
          key: "observerChunkMaxTokens",
          type: "number",
          label: "Observer chunk max",
          description: "Max source entry tokens sent to observer per chunk",
          value: cfg.observerChunkMaxTokens,
          min: 1e3,
          max: 2e5,
          step: 1e3
        },
        {
          key: "observerPreambleMaxTokens",
          type: "number",
          label: "Observer preamble max",
          description: "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)",
          value: cfg.observerPreambleMaxTokens,
          min: 0,
          max: 1e5,
          step: 500
        },
        {
          key: "dropperPressureThreshold",
          type: "number",
          label: "Dropper pressure threshold",
          description: "Fraction of observationsPoolMaxTokens that triggers pressure-driven dropper (1 disables)",
          value: cfg.dropperPressureThreshold,
          min: 0.01,
          max: 1,
          step: 0.01
        },
        {
          key: "dropperPoolFullnessThreshold",
          type: "number",
          label: "Dropper pool fullness threshold",
          description: "Min observation-pool fullness (fraction of pool max) before the dropper runs (0-1, default 0.10)",
          value: cfg.dropperPoolFullnessThreshold,
          min: 0.01,
          max: 1,
          step: 0.01
        },
        {
          key: "agentMaxTurns",
          type: "number",
          label: "Max turns per agent",
          description: "Shared turn cap for background memory agents",
          value: cfg.agentMaxTurns,
          min: 1,
          max: 100,
          step: 1
        },
        {
          key: "providerIdleTimeoutMs",
          type: "number",
          label: "Provider idle timeout (ms)",
          description: "Body-idle timeout for background provider streams; 0 = disabled, unset = inherit pi's default",
          value: cfg.providerIdleTimeoutMs ?? 0,
          min: 0,
          max: 36e5,
          step: 1e3
        },
        {
          key: "cacheRetention",
          type: "enum",
          label: "Worker prompt-cache retention",
          description: "Provider-neutral prompt-cache retention for the memory workers; unset defers to pi's effective setting. Adapters ignore values they do not support.",
          // "unset" is a modal-only sentinel: validate() drops it before the config
          // is persisted, so an untouched field never pins a value in the file.
          value: cfg.cacheRetention ?? "unset",
          options: ["unset", ...CACHE_RETENTION_VALUES],
          optionLabels: {
            unset: "unset \u2014 inherit pi's effective setting",
            none: "none \u2014 no prompt caching where supported",
            short: "short \u2014 pi's provider default",
            long: "long \u2014 extended retention where supported"
          }
        },
        {
          key: "workerAttemptTimeoutMs",
          type: "number",
          label: "Worker attempt timeout (ms)",
          description: "Hard elapsed deadline per worker/model attempt; timeout aborts the call and tries the next fallback; 0 = disabled",
          value: cfg.workerAttemptTimeoutMs ?? 0,
          min: 0,
          max: 36e5,
          step: 1e3
        },
        {
          key: "fullFoldAlways",
          type: "boolean",
          label: "Preserve OM on first compaction",
          description: "When true, early reflections/drops survive the first compaction in a fresh session",
          value: cfg.fullFoldAlways
        },
        // ── UI ──
        {
          key: "statusBar",
          type: "boolean",
          label: "Footer status bar",
          description: "Show token gauges (O/P/X) and worker events in the footer",
          value: cfg.statusBar
        },
        {
          key: "showWorkerNotifications",
          type: "boolean",
          label: "Worker notifications",
          description: "Show routine observer/reflector/dropper progress toasts; warnings, errors and compaction notices always show",
          value: cfg.showWorkerNotifications,
          valueDescriptions: {
            on: "On \u2014 routine worker progress toasts shown",
            off: "Off \u2014 quiet; warnings/errors only"
          }
        },
        // ── Debug ──
        {
          key: "debug",
          type: "boolean",
          label: "Debug snapshots",
          description: "Write detailed debug snapshots to /tmp/pi-blackhole-debug.json",
          value: cfg.debug
        },
        {
          key: "debugLog",
          type: "boolean",
          label: "Debug JSONL logging",
          description: "Write structured JSONL debug logs to agent directory",
          value: cfg.debugLog
        }
      ].map((field) => IGNORED_CONTROL_KEYS.some((key2) => key2 === field.key) ? { key: field.key, type: "readonly", label: `${field.label} (compatibility only)`, description: field.description, value: `${cfg[field.key] ?? "not set"} \u2014 ignored by Pi-owned compaction`, hint: "Read compatibility only. Explicit user save removes this ignored control; load/reload never rewrites it." } : field),
      /**
       * Validate raw loaded data, apply legacy migration, clamp numeric fields,
       * without reading environment. PASSIVE defaults and explicit env overrides
       * belong to the fixed environment layer; session overrides validate last.
       */
      validate: (raw, phase = "effective") => {
        const parsed = { ...raw };
        if (parsed.compaction === void 0 && parsed.compactionEngine === void 0) {
          if (parsed.passive === true) {
            parsed.compaction = "off";
            parsed.memory = false;
          } else if (parsed.noAutoCompact === true) {
            parsed.compaction = "manual";
          }
          if (parsed.overrideDefaultCompaction === true) {
            parsed.compactionEngine = "blackhole";
            if (parsed.tailBehavior === void 0) {
              parsed.tailBehavior = "minimal";
            }
          } else if (parsed.overrideDefaultCompaction === false) {
            parsed.compactionEngine = "pi-default";
          }
          delete parsed.passive;
          delete parsed.noAutoCompact;
          delete parsed.overrideDefaultCompaction;
        }
        normalizeThresholdKnobs(parsed, phase === "file");
        const cacheRetention = normalizeCacheRetention(parsed.cacheRetention);
        if (cacheRetention) {
          parsed.cacheRetention = cacheRetention;
        } else {
          delete parsed.cacheRetention;
        }
        const merged = { ...DEFAULTS, ...parsed };
        const REQUIRED_NUMERIC_KEYS = [
          "observeAfterTokens",
          "reflectAfterTokens",
          "retainedToolOutputMaxTokens",
          "observationsPoolMaxTokens",
          "reflectionsPoolMaxTokens",
          "observationsPoolTargetTokens",
          "reflectorInputMaxTokens",
          "dropperInputMaxTokens",
          "observerChunkMaxTokens",
          "observerPreambleMaxTokens",
          "agentMaxTurns"
        ];
        for (const k of REQUIRED_NUMERIC_KEYS) {
          const v = merged[k];
          const minVal = k === "observerPreambleMaxTokens" || k === "reflectionsPoolMaxTokens" ? 0 : 1;
          if (typeof v !== "number" || !Number.isFinite(v) || (k === "retainedToolOutputMaxTokens" || k === "reflectionsPoolMaxTokens") && !Number.isInteger(v) || v < minVal) {
            merged[k] = DEFAULTS[k];
          }
        }
        const dpt = merged.dropperPressureThreshold;
        if (typeof dpt !== "number" || !Number.isFinite(dpt) || dpt <= 0 || dpt > 1) {
          merged.dropperPressureThreshold = DEFAULTS.dropperPressureThreshold;
        }
        const dpf = merged.dropperPoolFullnessThreshold;
        if (typeof dpf !== "number" || !Number.isFinite(dpf) || dpf <= 0 || dpf > 1) {
          merged.dropperPoolFullnessThreshold = DEFAULTS.dropperPoolFullnessThreshold;
        }
        if (merged.observationsPoolTargetTokens === void 0 || merged.observationsPoolTargetTokens >= merged.observationsPoolMaxTokens) {
          merged.observationsPoolTargetTokens = Math.floor(merged.observationsPoolMaxTokens / 2);
        }
        return merged;
      },
      envBase: (cfg) => {
        const value = process.env.PI_BLACKHOLE_PASSIVE ?? process.env.PI_VCC_OM_PASSIVE ?? process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
        if (["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "")) return { ...cfg, compaction: "off", memory: false };
        return cfg;
      },
      diagnostics: (explicit) => {
        const warning = piOwnedSettingsWarning(explicit);
        return warning ? [warning] : [];
      },
      env: DECLARATIVE_ENV_OVERRIDES
    });
  }
});

// modules/blackhole/src/om/key-matcher.ts
import { visibleWidth as visibleWidth4 } from "@earendil-works/pi-tui";
var init_key_matcher = __esm({
  "modules/blackhole/src/om/key-matcher.ts"() {
    "use strict";
  }
});

// modules/blackhole/src/commands/cleanup.ts
var cleanup_exports = {};
__export(cleanup_exports, {
  handleCleanup: () => handleCleanup
});
import { matchesKey as matchesKey13, decodeKittyPrintable as decodeKittyPrintable2 } from "@earendil-works/pi-tui";
function clampIndex(idx, length) {
  if (length === 0) return 0;
  return Math.max(0, Math.min(idx, length - 1));
}
function buildTopBorder(width, border, dim, title, right) {
  const innerW = Math.max(1, width - 2);
  if (!title && !right) {
    return border(`\u250F${"\u2501".repeat(innerW)}\u2513`);
  }
  const rightText = right ? ` ${right} ` : "";
  const titleBudget = Math.max(1, innerW - visibleWidth4(rightText) - 1);
  const titleFitted = title ? ` ${title.slice(0, Math.max(1, titleBudget - 2))}${title.length > titleBudget - 2 ? "\u2026" : ""} ` : "";
  const fill = Math.max(1, innerW - visibleWidth4(titleFitted) - visibleWidth4(rightText));
  return border(`\u250F${titleFitted}${"\u2501".repeat(fill)}${right ? dim(rightText) : ""}\u2513`);
}
function createCleanupPicker(orphaned, theme, done) {
  let selectedIndex = 0;
  let scrollOffset = 0;
  let confirmDeleteAll = false;
  function clampScroll() {
    const count = orphaned.length;
    selectedIndex = clampIndex(selectedIndex, count);
    const maxOffset = Math.max(0, count - LIST_ROWS);
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    if (selectedIndex >= scrollOffset + LIST_ROWS && count > 0) {
      scrollOffset = selectedIndex - LIST_ROWS + 1;
    }
  }
  const bdr = (t) => theme.fg("border", t);
  const dim = (t) => theme.fg("dim", t);
  const accent = (t) => theme.fg("accent", t);
  const err = (t) => theme.fg("error", t);
  const now = Date.now();
  function itemLine(pf, isSel, cw) {
    const desc = describeFile(pf, now);
    const prefix = isSel ? accent(" \u25B6") : "  ";
    const main2 = isSel ? accent(desc) : desc;
    const line = `${prefix} ${main2}`;
    return ` ${line}${" ".repeat(Math.max(0, cw - visibleWidth4(line)))} `;
  }
  return {
    invalidate() {
    },
    render(width) {
      const w = Math.max(40, width);
      const innerW = Math.max(1, w - 2);
      const PX = 1;
      const cw = Math.max(1, innerW - PX * 2);
      const lines = [];
      if (confirmDeleteAll) {
        const title = `Delete ${orphaned.length} orphaned file${orphaned.length === 1 ? "" : "s"}?`;
        lines.push(buildTopBorder(w, bdr, dim, "Cleanup Pending Files"));
        lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
        lines.push(bdr(`\u2503 ${err(title)}${" ".repeat(Math.max(0, cw - visibleWidth4(title)))} \u2503`));
        lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
        const hint = "Enter confirm \xB7 Esc cancel";
        lines.push(bdr(`\u2503 ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth4(hint)))} \u2503`));
        lines.push(bdr(`\u2517${"\u2501".repeat(innerW)}\u251B`));
        return lines;
      }
      clampScroll();
      const sizeLabel = `${orphaned.length} file${orphaned.length === 1 ? "" : "s"}`;
      lines.push(buildTopBorder(w, bdr, dim, "Orphaned Pending Files", sizeLabel));
      lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
      if (orphaned.length === 0) {
        lines.push(
          bdr(`\u2503 ${dim("No orphaned pending files found")}${" ".repeat(Math.max(0, cw - 29))} \u2503`)
        );
      } else {
        const visible = orphaned.slice(scrollOffset, scrollOffset + LIST_ROWS);
        for (let vi = 0; vi < visible.length; vi++) {
          const idx = scrollOffset + vi;
          const pf = visible[vi];
          if (!pf) continue;
          const isSel = idx === selectedIndex;
          const row = itemLine(pf, isSel, cw);
          lines.push(isSel ? theme.bg("selectedBg", bdr(`\u2503${row}\u2503`)) : bdr(`\u2503${row}\u2503`));
        }
      }
      for (let i = Math.min(orphaned.length, LIST_ROWS); i < LIST_ROWS; i++) {
        lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
      }
      lines.push(bdr(`\u2503${" ".repeat(innerW)}\u2503`));
      if (orphaned.length > 0) {
        const totalBytes = orphaned.reduce((s, pf) => s + pf.sizeBytes, 0);
        const kb = totalBytes > 0 ? (totalBytes / 1024).toFixed(1) : "0.0";
        const totalStr = `Total: ${kb} KB`;
        const hint = "\u2191\u2193 navigate  Enter delete  D delete all  Esc cancel";
        lines.push(
          bdr(`\u2503 ${dim(totalStr)}${" ".repeat(Math.max(0, cw - visibleWidth4(totalStr)))} \u2503`)
        );
        lines.push(bdr(`\u2503 ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth4(hint)))} \u2503`));
      } else {
        const hint = "Esc close";
        lines.push(bdr(`\u2503 ${dim(hint)}${" ".repeat(Math.max(0, cw - visibleWidth4(hint)))} \u2503`));
      }
      lines.push(bdr(`\u2517${"\u2501".repeat(innerW)}\u251B`));
      return lines;
    },
    handleInput(data) {
      const key2 = decodeKittyPrintable2(data) ?? data;
      if (confirmDeleteAll) {
        if (matchesKey13(data, "enter") || matchesKey13(data, "return")) {
          done("deleteAll");
          return;
        }
        if (matchesKey13(data, "escape")) {
          confirmDeleteAll = false;
          return;
        }
        return;
      }
      if (orphaned.length === 0) {
        if (matchesKey13(data, "escape")) done("cancel");
        return;
      }
      if (matchesKey13(data, "up")) {
        selectedIndex = clampIndex(selectedIndex - 1, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey13(data, "down")) {
        selectedIndex = clampIndex(selectedIndex + 1, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey13(data, "pageUp") || key2 === "-") {
        selectedIndex = clampIndex(selectedIndex - LIST_ROWS, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey13(data, "pageDown") || key2 === "=") {
        selectedIndex = clampIndex(selectedIndex + LIST_ROWS, orphaned.length);
        clampScroll();
        return;
      }
      if (matchesKey13(data, "home")) {
        selectedIndex = 0;
        scrollOffset = 0;
        return;
      }
      if (matchesKey13(data, "end")) {
        selectedIndex = Math.max(0, orphaned.length - 1);
        clampScroll();
        return;
      }
      if (matchesKey13(data, "enter") || matchesKey13(data, "return")) {
        const pf = orphaned[selectedIndex];
        if (pf) {
          deletePendingFiles(pf.sessionId);
          orphaned.splice(selectedIndex, 1);
          if (orphaned.length === 0) {
            done("cancel");
            return;
          }
          selectedIndex = clampIndex(selectedIndex, orphaned.length);
          clampScroll();
        }
        return;
      }
      if (key2 === "d" || key2 === "D") {
        confirmDeleteAll = true;
        return;
      }
      if (matchesKey13(data, "escape")) {
        done("cancel");
        return;
      }
    }
  };
}
async function handleCleanup(ctx) {
  const { orphaned } = analyzeOrphaned();
  if (orphaned.length === 0) {
    ctx.ui.notify("pi-blackhole: No orphaned pending files found.", "info");
    return;
  }
  const isRpc = ctx.mode === "rpc" || ctx.mode === "json" || ctx.mode === "print";
  if (isRpc) {
    const totalSize = orphaned.reduce((s, pf) => s + pf.sizeBytes, 0);
    const lines = [
      `Orphaned pending files: ${orphaned.length} (${(totalSize / 1024).toFixed(1)} KB)`,
      "",
      ...orphaned.map((pf) => `  ${describeFile(pf)}`),
      "",
      "Use /blackhole cleanup in TUI mode to delete these files."
    ];
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }
  const items = [...orphaned];
  const result = await ctx.ui.custom(
    (_tui, theme, _kb, done) => {
      return createCleanupPicker(items, theme, done);
    },
    { overlay: true }
  );
  if (result === "deleteAll") {
    const deleted = deleteOrphanedBatch(items);
    const intended = items.length;
    if (deleted === intended) {
      ctx.ui.notify(
        `pi-blackhole: Deleted ${intended} orphaned pending file${intended === 1 ? "" : "s"}.`,
        "info"
      );
    } else {
      ctx.ui.notify(
        `pi-blackhole: Deleted ${deleted}/${intended} orphaned pending file${intended === 1 ? "" : "s"} (${intended - deleted} failed).`,
        "warning"
      );
    }
  } else if (items.length > 0 && items.length < orphaned.length) {
    const remainingSize = items.reduce((s, pf) => s + pf.sizeBytes, 0);
    ctx.ui.notify(
      `pi-blackhole: ${orphaned.length - items.length} deleted, ${items.length} remain (${(remainingSize / 1024).toFixed(1)} KB).`,
      "info"
    );
  } else if (items.length === 0 && orphaned.length > 0) {
    ctx.ui.notify(
      `pi-blackhole: All ${orphaned.length} orphaned pending file${orphaned.length === 1 ? "" : "s"} removed.`,
      "info"
    );
  }
}
var LIST_ROWS;
var init_cleanup2 = __esm({
  "modules/blackhole/src/commands/cleanup.ts"() {
    "use strict";
    init_key_matcher();
    init_cleanup();
    LIST_ROWS = 10;
  }
});

// plan/review-20261012-evidence/verify-blackhole/probe.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join as join12, resolve as resolve4, sep as sep3 } from "node:path";

// modules/blackhole/src/om/pending.ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
var PENDING_DIR = "pi-blackhole";
var PENDING_SUFFIX = "-pending.json";
var STALE_SUFFIX = "-pending.stale.json";
function pendingPath(sessionId) {
  return join(getAgentDir(), PENDING_DIR, `${sessionId}${PENDING_SUFFIX}`);
}
function stalePath(sessionId) {
  return join(getAgentDir(), PENDING_DIR, `${sessionId}${STALE_SUFFIX}`);
}
function ensureDir() {
  const dir2 = join(getAgentDir(), PENDING_DIR);
  if (!existsSync(dir2)) mkdirSync(dir2, { recursive: true });
}
function defaultState() {
  return {};
}
function isEmptyState(s) {
  const hasCursors = s.cursors && (s.cursors.observer || s.cursors.reflector || s.cursors.dropper);
  if (hasCursors) return false;
  return !s.observation && !s.reflection && !s.dropped && (!s.observationBatches || s.observationBatches.length === 0) && (!s.reflectionBatches || s.reflectionBatches.length === 0) && (!s.droppedBatches || s.droppedBatches.length === 0);
}
function readSessionState(sessionId) {
  const path = pendingPath(sessionId);
  if (!existsSync(path)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (isPendingOMState(raw)) return sanitizePendingState(raw);
    return defaultState();
  } catch {
    return defaultState();
  }
}
function writeSessionState(sessionId, state) {
  const path = pendingPath(sessionId);
  if (isEmptyState(state)) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
    }
    try {
      const stale2 = stalePath(sessionId);
      if (existsSync(stale2)) unlinkSync(stale2);
    } catch {
    }
    return;
  }
  ensureDir();
  try {
    if (existsSync(path)) {
      renameSync(path, stalePath(sessionId));
    }
  } catch {
  }
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}
`);
  } catch {
  }
}
function isPendingOMState(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  const hasObs = !!(v.observation && typeof v.observation === "object" && typeof v.observation.coversUpToId === "string");
  const hasRef = !!(v.reflection && typeof v.reflection === "object" && typeof v.reflection.coversUpToId === "string");
  const hasDrop = !!(v.dropped && typeof v.dropped === "object" && typeof v.dropped.coversUpToId === "string");
  const hasBatches = Array.isArray(v.observationBatches) || Array.isArray(v.reflectionBatches) || Array.isArray(v.droppedBatches);
  const hasCursors = !!(v.cursors && typeof v.cursors === "object");
  return hasObs || hasRef || hasDrop || hasBatches || hasCursors;
}
function sanitizePendingState(raw) {
  const sanitized = {
    ...raw,
    observation: raw.observation ?? void 0,
    reflection: raw.reflection ?? void 0,
    dropped: raw.dropped ?? void 0
  };
  if (Array.isArray(raw.observationBatches)) {
    sanitized.observationBatches = raw.observationBatches.filter(
      (b) => !!b && typeof b === "object" && typeof b.coversUpToId === "string" && b.data !== void 0
    );
  }
  if (Array.isArray(raw.reflectionBatches)) {
    sanitized.reflectionBatches = raw.reflectionBatches.filter(
      (b) => !!b && typeof b === "object" && typeof b.coversUpToId === "string" && b.data !== void 0
    );
  }
  if (Array.isArray(raw.droppedBatches)) {
    sanitized.droppedBatches = raw.droppedBatches.filter(
      (b) => !!b && typeof b === "object" && typeof b.coversUpToId === "string" && b.data !== void 0
    );
  }
  return sanitized;
}
function savePendingObservation(sessionId, entry) {
  const state = readSessionState(sessionId);
  state.observation = entry;
  state.observationBatches = [...state.observationBatches ?? [], entry];
  writeSessionState(sessionId, state);
}
function savePendingReflection(sessionId, entry) {
  const state = readSessionState(sessionId);
  state.reflection = entry;
  state.reflectionBatches = [...state.reflectionBatches ?? [], entry];
  writeSessionState(sessionId, state);
}
function savePendingDropped(sessionId, entry) {
  const state = readSessionState(sessionId);
  state.dropped = entry;
  state.droppedBatches = [...state.droppedBatches ?? [], entry];
  writeSessionState(sessionId, state);
}
function isObservationChunkPending(sessionId, coversUpToId) {
  const s = readSessionState(sessionId);
  return s.observation?.coversUpToId === coversUpToId;
}
function readPendingState(sessionId) {
  return readSessionState(sessionId);
}
function readPendingCursors(sessionId) {
  const state = readSessionState(sessionId);
  return state.cursors;
}
function writePendingCursors(sessionId, cursors) {
  const state = readSessionState(sessionId);
  state.cursors = { ...cursors };
  writeSessionState(sessionId, state);
}

// plan/review-20261012-evidence/verify-blackhole/probe.ts
init_cleanup();

// modules/blackhole/src/om/config.ts
init_unified_config();
var DEFAULTS2 = DEFAULTS;

// modules/blackhole/src/om/cooldown.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname3, join as join6 } from "node:path";
import { getAgentDir as getAgentDir5 } from "@earendil-works/pi-coding-agent";

// modules/blackhole/src/om/retryable-error.ts
var RETRYABLE_ERROR_RE = /overloaded|provider.?returned.?error|rate.?limit|too many requests|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
function isRetryableError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_ERROR_RE.test(message);
}
var DETERMINISTIC_ERROR_RE = /MissingSessionID|missing.?session|invalid.?api.?key|unauthorized|HTTP\s+40[014]\b|HTTP\s+4(?:03|22)\b|status\s*:?\s*40[014]\b|status\s*:?\s*4(?:03|22)\b|error\s*:?\s*40[014]\b|error\s*:?\s*4(?:03|22)\b/i;
var BARE_DETERMINISTIC_CODE_RE = /(?:^|[\s:([{="'])(40[014]|403|422)\b/;
var DETERMINISTIC_SIGNAL_RE = /error|fail|missing|forbidden|denied|bad request|not found|unauthorized|invalid/i;
var WORKER_NAMES = ["Observer", "Reflector", "Dropper"];
function workerStreamErrorMessage(worker, providerText) {
  return `${worker} API error: ${providerText}`;
}
var WORKER_FRAMING_RE = new RegExp(`^(?:${WORKER_NAMES.join("|")}) API error: `);
var WorkerStreamError = class extends Error {
  constructor(message, discardedCount, turnCapExhausted = false, lengthCut = false) {
    super(message);
    this.discardedCount = discardedCount;
    this.turnCapExhausted = turnCapExhausted;
    this.lengthCut = lengthCut;
    this.name = "WorkerStreamError";
  }
  discardedCount;
  turnCapExhausted;
  lengthCut;
};
var DISCARDED_COUNT = /* @__PURE__ */ Symbol.for("pi-blackhole.discardedCount");
function isAttachable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function getDiscardedCount(error) {
  if (error instanceof WorkerStreamError) return error.discardedCount;
  if (isAttachable(error)) {
    const attached = Reflect.get(error, DISCARDED_COUNT);
    if (typeof attached === "number") return attached;
  }
  return void 0;
}
function isDeterministicError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (DETERMINISTIC_ERROR_RE.test(message)) return true;
  const providerText = message.replace(WORKER_FRAMING_RE, "");
  return BARE_DETERMINISTIC_CODE_RE.test(providerText) && DETERMINISTIC_SIGNAL_RE.test(providerText);
}
function isCooldownWorthyError(error) {
  return isRetryableError(error) || isDeterministicError(error);
}
function isStaleExtensionContextError(error) {
  let message;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    message = String(error.message);
  } else {
    message = String(error || "");
  }
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}

// modules/blackhole/src/om/cooldown.ts
var CONFIG_DIR2 = "pi-blackhole";
var COOLDOWN_FILE = "pi-blackhole-cooldown.json";
function cooldownPath() {
  return join6(getAgentDir5(), CONFIG_DIR2, COOLDOWN_FILE);
}
function modelKey(model) {
  return `${model.provider.trim().toLowerCase()}/${model.id.trim().toLowerCase()}`;
}
function readCooldownMap() {
  const path = cooldownPath();
  if (!existsSync4(path)) return {};
  try {
    const raw = JSON.parse(readFileSync5(path, "utf-8"));
    const map = {};
    for (const [key2, entry] of Object.entries(raw)) {
      if (entry) map[key2.trim().toLowerCase()] = entry;
    }
    return map;
  } catch {
    return {};
  }
}
function writeCooldownMap(map) {
  try {
    const path = cooldownPath();
    const dir2 = dirname3(path);
    if (!existsSync4(dir2)) mkdirSync4(dir2, { recursive: true });
    writeFileSync4(path, `${JSON.stringify(map, null, 2)}
`);
  } catch {
  }
}
function isCooldownActive(model, now = /* @__PURE__ */ new Date()) {
  return getCooldownEntry(model, now) !== void 0;
}
function getCooldownEntry(model, now = /* @__PURE__ */ new Date()) {
  if (model.cooldownHours === 0) return void 0;
  const map = readCooldownMap();
  const key2 = modelKey(model);
  const entry = map[key2];
  if (!entry) return void 0;
  const until = new Date(entry.until);
  if (isNaN(until.getTime())) return void 0;
  if (now >= until) {
    delete map[key2];
    writeCooldownMap(map);
    return void 0;
  }
  return entry;
}
var COOLDOWN_REASON_MAX = 200;
function sanitizeCooldownReason(rawReason) {
  let s = rawReason.replace(/\s*\{[\s\S]*?\}\s*$/, "").trim();
  const htmlStart = s.search(/<\s*(!doctype|html|head|body)/i);
  if (htmlStart !== -1) {
    const prefix = s.slice(0, htmlStart).trim();
    if (prefix) {
      s = prefix;
    } else {
      return httpStatusFrom(rawReason) ?? "HTTP error (HTML body omitted)";
    }
  } else if (/^\s*</.test(s) || /<[a-zA-Z][^>]*>/.test(s)) {
    const lt = s.indexOf("<");
    const prefix = lt > 0 ? s.slice(0, lt).trim() : "";
    if (prefix) {
      s = prefix;
    } else {
      return httpStatusFrom(rawReason) ?? "HTTP error (HTML body omitted)";
    }
  }
  if (/^\s*</.test(s)) {
    return httpStatusFrom(rawReason) ?? "HTTP error (HTML body omitted)";
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return httpStatusFrom(rawReason) ?? "unknown error";
  if (s.length > COOLDOWN_REASON_MAX) s = `${s.slice(0, COOLDOWN_REASON_MAX - 3).trimEnd()}...`;
  return s;
}
function httpStatusFrom(text) {
  const m = text.match(/HTTP\/?[\d.]*\s+(\d{3})(?:\s+([A-Za-z][A-Za-z'\- ]{0,40}))?/);
  if (m) {
    const phrase = m[2]?.trim();
    return phrase ? `HTTP ${m[1]} ${phrase}` : `HTTP ${m[1]}`;
  }
  const st = text.match(/\bstatus\s*:?\s*(\d{3})/i);
  if (st) return `HTTP ${st[1]}`;
  const code = text.match(/\b(400|401|402|403|404|407|408|409|422|425|429|500|502|503|504)\b/);
  if (code) return `HTTP ${code[1]}`;
  return void 0;
}
function recordCooldown(model, reason, stage) {
  if (model.cooldownHours === 0) return;
  const hours = model.cooldownHours ?? 1;
  const until = new Date(Date.now() + hours * 36e5).toISOString();
  const map = readCooldownMap();
  map[modelKey(model)] = { until, reason: sanitizeCooldownReason(reason), stage };
  writeCooldownMap(map);
}
function expireCooldowns() {
  const map = readCooldownMap();
  const now = /* @__PURE__ */ new Date();
  let changed = false;
  for (const [key2, entry] of Object.entries(map)) {
    const until = new Date(entry.until);
    if (isNaN(until.getTime()) || now >= until) {
      delete map[key2];
      changed = true;
    }
  }
  if (changed) writeCooldownMap(map);
}

// modules/blackhole/src/om/debug-log.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync as existsSync5, mkdirSync as mkdirSync5, renameSync as renameSync2, statSync as statSync3, unlinkSync as unlinkSync3, appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname as dirname4, join as join7 } from "node:path";
import { getAgentDir as getAgentDir6 } from "@earendil-works/pi-coding-agent";
var DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
var DEBUG_LOG_RELATIVE_PATH = join7("pi-blackhole", "debug.ndjson");
var storage = new AsyncLocalStorage();
var BUFFER_FLUSH_MS = 1e3;
var FLUSH_IDLE_MS = 1e4;
var buffer = [];
var flushTimer = null;
var flushing = false;
var lastWriteMs = 0;
function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (buffer.length === 0 && lastWriteMs > 0 && Date.now() - lastWriteMs > FLUSH_IDLE_MS) {
      clearInterval(flushTimer);
      flushTimer = null;
      return;
    }
    flushBuffer().catch(() => {
    });
  }, BUFFER_FLUSH_MS);
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}
async function flushBuffer() {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;
  const batch2 = buffer;
  buffer = [];
  try {
    const path = join7(getAgentDir6(), DEBUG_LOG_RELATIVE_PATH);
    mkdirSync5(dirname4(path), { recursive: true });
    rotateIfNeeded(path);
    await appendFile(path, batch2.join(""), "utf-8");
  } catch (error) {
    console.error("blackhole: debug log write failed", error);
  } finally {
    flushing = false;
  }
}
process.on("exit", () => {
  flushDebugLog();
});
function debugLog(event, data = {}, forceEnabled) {
  const context = storage.getStore();
  const enabled = forceEnabled ?? context?.enabled ?? false;
  if (enabled !== true) return;
  const payload = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    cwd: context?.cwd,
    runId: context?.runId,
    data
  };
  buffer.push(JSON.stringify(payload) + "\n");
  lastWriteMs = Date.now();
  ensureFlushTimer();
}
function flushDebugLog() {
  if (flushing || buffer.length === 0) return;
  const batch2 = buffer;
  buffer = [];
  try {
    const path = join7(getAgentDir6(), DEBUG_LOG_RELATIVE_PATH);
    mkdirSync5(dirname4(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, batch2.join(""), "utf-8");
  } catch (error) {
    console.error("blackhole: debug log flush failed", error);
  }
}
function rotateIfNeeded(path) {
  if (!existsSync5(path)) return;
  if (statSync3(path).size < DEBUG_LOG_MAX_BYTES) return;
  const backupPath = `${path}.1`;
  if (existsSync5(backupPath)) unlinkSync3(backupPath);
  renameSync2(path, backupPath);
}

// modules/blackhole/src/om/runtime.ts
async function resolveAuthBaseUrl(modelRegistry, model, auth) {
  const directBaseUrl = typeof auth.baseUrl === "string" ? auth.baseUrl.trim() : "";
  if (directBaseUrl) return directBaseUrl;
  if (typeof modelRegistry.getProviderAuth !== "function") return void 0;
  try {
    const resolved = await modelRegistry.getProviderAuth(model.provider);
    const baseUrl = resolved?.auth?.baseUrl;
    return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : void 0;
  } catch {
    return void 0;
  }
}
async function withResolvedAuthEndpoint(modelRegistry, model, auth) {
  const baseUrl = await resolveAuthBaseUrl(modelRegistry, model, auth);
  return baseUrl && baseUrl !== model.baseUrl ? { ...model, baseUrl } : model;
}
var CONSOLIDATION_RETRY_COOLDOWN_MS = 3e4;
var AVAILABILITY_RECHECK_TIMEOUT_MS = 5e3;
var AVAILABILITY_RECHECK_REARM_MS = 6e4;
function hasUsableAuth(auth) {
  if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
  if (!auth.headers || typeof auth.headers !== "object") return false;
  return Object.values(auth.headers).some(
    (value) => typeof value === "string" && value.length > 0
  );
}
var Runtime = class {
  config = { ...DEFAULTS2 };
  configLoaded = false;
  consolidationInFlight = false;
  consolidationPromise = null;
  consolidationPhase;
  /**
   * Models that failed in the current consolidation stage (in-memory only).
   * Used when cooldownHours is 0 — avoids disk writes while still letting
   * the retry loop advance past the failed model within this stage.
   * Cleared between stages at the pipeline level.
   */
  failedInCycle = /* @__PURE__ */ new Set();
  /**
   * Models skipped in the current consolidation stage because the sized input
   * does not fit their context window (in-memory only). A too-small window is
   * not a broken model, so — unlike recordRetryableError — this never writes
   * a persisted cooldown: the model stays available for smaller inputs and
   * for the shrink-to-fit pass. Cleared between stages alongside failedInCycle.
   */
  sizeSkippedInCycle = /* @__PURE__ */ new Set();
  compactInFlight = false;
  compactHookInFlight = false;
  /** AbortController for the pending auto-compaction wait loop, or null if none.
   * Set when handleAgentEnd schedules a wait; cleared on abort, success, or terminal bail.
   * agent_start handlers read this to abort the pending wait when a new turn starts. */
  autoCompactionController = null;
  /** Exponential backoff state for failed/cancelled mid-run compaction attempts.
   * `retryAfter` gates re-triggering; failures reset when a compaction succeeds,
   * pressure drops below the threshold, or an auto-compaction completes.
   * Replaces the earlier permanent-suspension latch (PR #38) so transient
   * failures self-heal instead of wedging compaction until pressure drops. */
  midRunCompactionRetry = {
    failures: 0,
    retryAfter: 0
  };
  /** Set when the host inline-compaction adapter reports permanent
   * unavailability (pi version lacks the API). Mirrors the structural
   * shape of InlineCompactionAdapterStatus without importing it. */
  inlineCompactionAdapterStatus;
  /** One-shot guard for the settled-fallback user notification. */
  inlineCompactionWarningEmitted = false;
  /** Count of scheduled auto-compactions skipped because the extension ctx went
   * stale before the deferred microtask could run — typically in-memory
   * subagent/flow sessions disposed right after `agent_end` (issue #92).
   * Process-wide: nested sessions share this runtime, so the parent's
   * /blackhole-memory status surfaces child-session skips. */
  staleCtxSkippedCompactions = 0;
  /** Session ids already warned about a stale-ctx skip (warn once per session,
   * bounded — see STALE_SKIP_WARN_MAX_SESSIONS). */
  staleCtxWarnedSessions = /* @__PURE__ */ new Set();
  resolveFailureNotified = false;
  lastObserverError;
  lastReflectorError;
  lastDropperError;
  /** Provider -> epoch ms of the last stale availability re-check. */
  availabilityRecheckedAt = /* @__PURE__ */ new Map();
  /** Epoch ms of the last failed consolidation run (any stage). */
  lastConsolidationErrorAt;
  /** Stats from the most recent compaction run (session-scoped via handler closure). */
  compactionStats = null;
  /** Whether the current compaction attempt was triggered by /blackhole.
   *  Overwritten at every session_before_compact and consumed by either the
   *  session_compact or session_compact_failed handler, preventing stale
   *  attribution from leaking into a later pi-default attempt. */
  compactWasPiVcc = false;
  /** True when the current session_before_compact returned { cancel: true } from
   *  blackhole's own-cut guards. Set immediately before the cancel return and reset
   *  at the start of every session_before_compact; consumed by the
   *  session_compact_failed handler to attribute aborted compactions that pi
   *  mislabels as fromExtension: false (pi only flags content-bearing compactions). */
  lastCompactCancelled = false;
  /** Set after the first append-mode fallback warning; one signal per session. */
  appendFallbackNotified = false;
  /** In‑memory pipeline cursors — authoritative copy for gating decisions. */
  cursors = {};
  /** Session ID for which cursors have been loaded/validated.  Undefined until first load. */
  cursorsLoadedSessionId = void 0;
  /** Info-notification gate: only the first info-level notification per turn/phase is emitted. */
  hasEmittedInfoThisTurn = false;
  // ── Session generation lifecycle (PR #58: stale-runtime append protection) ──
  generation = 0;
  sessionIdentity;
  disposed = false;
  lifecycleController = new AbortController();
  compactionTimer;
  /**
   * Called on session_start. Increments the generation counter and aborts the
   * lifecycle signal when the session identity changes.  Cancels any pending
   * deferred compaction timer.  The old extension's deferred work is thereby
   * invalidated.
   */
  startSession(sessionIdentity) {
    if (this.disposed) return;
    if (this.sessionIdentity !== void 0 && this.sessionIdentity !== sessionIdentity) {
      this.lifecycleController.abort();
      this.lifecycleController = new AbortController();
      this.generation += 1;
      this.clearCompactionTimer();
      this.compactInFlight = false;
    }
    this.sessionIdentity = sessionIdentity;
  }
  /**
   * Captures the current generation for use in deferred work.
   * The returned RuntimeGeneration carries a generation number,
   * session identity, and an AbortSignal that fires on session change.
   */
  captureGeneration(sessionIdentity, branchLeafId) {
    return {
      generation: this.generation,
      sessionIdentity,
      signal: this.lifecycleController.signal,
      branchLeafId
    };
  }
  /**
   * Same-session tree navigation (session_before_tree / session_tree) keeps the session id, so the
   * session generation cannot revoke branch-A workers. Start a new branch epoch: abort in-flight
   * workers and invalidate captured generations. Ordinary conversation progress never calls this.
   */
  advanceBranchEpoch() {
    if (this.disposed) return;
    this.lifecycleController.abort();
    this.lifecycleController = new AbortController();
    this.generation += 1;
    this.clearCompactionTimer();
  }
  /**
   * Checks whether a captured generation is still active.
   * Returns false when the runtime is disposed, the signal is aborted,
   * the generation counter has advanced, or the session identity changed.
   *
   * When `startSession` was never called (`this.sessionIdentity` is undefined),
   * the identity check is skipped — this allows tests and direct pipeline
   * calls to work without explicitly calling `startSession` first.
   */
  isGenerationActive(captured) {
    return !this.disposed && !captured.signal.aborted && captured.generation === this.generation && (this.sessionIdentity === void 0 || captured.sessionIdentity === this.sessionIdentity);
  }
  /**
   * Stores the compaction timer handle so dispose() can cancel it.
   */
  setCompactionTimer(timer) {
    if (this.disposed) {
      clearTimeout(timer);
      return;
    }
    this.compactionTimer = timer;
  }
  /**
   * Clears the stored compaction timer.  If `timer` is provided and differs
   * from the stored timer, this is a no-op (defensive: prevents clearing a
   * timer that was already replaced by a newer one).
   */
  clearCompactionTimer(timer) {
    if (timer !== void 0 && this.compactionTimer !== timer) return;
    if (this.compactionTimer !== void 0) clearTimeout(this.compactionTimer);
    this.compactionTimer = void 0;
  }
  /**
   * Called on session_shutdown.  Aborts the lifecycle signal, increments
   * the generation counter, and clears the compaction timer.  All deferred
   * work is thereby invalidated.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.lifecycleController.abort();
    this.clearCompactionTimer();
    this.compactInFlight = false;
  }
  /**
   * Emit an info-level notification if none has been emitted this turn/phase yet.
   * Returns true if emitted, false if suppressed (already emitted earlier).
   */
  tryEmitInfo(hasUI, ui, message) {
    if (!hasUI || !ui || typeof ui.notify !== "function") return false;
    if (this.hasEmittedInfoThisTurn) return false;
    this.hasEmittedInfoThisTurn = true;
    try {
      ui.notify(message, "info");
    } catch {
    }
    return true;
  }
  /** Reset the info gate — call at agent_start and agent_end to allow one
   *  notification per phase. */
  resetInfoGate() {
    this.hasEmittedInfoThisTurn = false;
  }
  /**
   * Emit a routine observer/reflector/dropper progress toast, unless the user
   * turned worker notifications off (`showWorkerNotifications: false`).
   *
   * Only routine progress goes through here — model fallback/unavailability,
   * no-output warnings, worker failures and compaction notices keep using
   * `tryEmitInfo` / `ui.notify` directly so they stay visible when the knob is
   * off.
   */
  tryEmitWorkerInfo(hasUI, ui, message) {
    if (this.config.showWorkerNotifications === false) return false;
    return this.tryEmitInfo(hasUI, ui, message);
  }
  ensureConfig(cwd, warn) {
    if (this.configLoaded) return;
    this.config = loadUnifiedConfig(cwd, warn);
    this.configLoaded = true;
    expireCooldowns();
  }
  /**
   * Force reload config from disk, discarding cached values.
   * Call this after external config changes (e.g., overlay save, manual edit).
   */
  reloadConfig(cwd, warn) {
    this.configLoaded = false;
    this.ensureConfig(cwd, warn);
  }
  /**
   * Build the ordered model candidate list for a stage:
   * 1. Primary stage model (observerModel, reflectorModel, dropperModel)
   * 2. Stage fallbacks (observerFallbackModels, etc.)
   * 3. Base config.model
   *
   * Session model (ctx.model) is only used as the last resort inside resolveModel.
   */
  buildCandidateList(stageModel, stageFallbacks) {
    const candidates = [];
    if (stageModel) candidates.push(stageModel);
    if (stageFallbacks) candidates.push(...stageFallbacks);
    if (this.config.model) candidates.push(this.config.model);
    return candidates;
  }
  /**
   * Resolve a model for a consolidation stage.
   *
   * Tries the candidate list in order:
   * 1. Primary stage model → 2. Stage fallbacks → 3. Base config.model → 4. Session model.
   *
   * Session model fallback can be disabled via config.sessionFallback: false.
   * When disabled, returns { ok: false } instead of using the session model,
   * allowing the stage to be skipped entirely when all configured OM models fail.
   *
   * Skips models that are currently in a cooldown window.
   * On retryable error (after the agent runs), the model that failed is cooled down
   * and the next candidate is tried.  The caller must call `recordRetryableError`
   * after the API attempt to mark the failed model.
   *
   * Returns `ok: true` with the resolved model, or `ok: false` with a reason
   * if all candidates (including session model, if enabled) are exhausted or unavailable.
   */
  async resolveModel(ctx, signal) {
    const parent = signal ?? this.lifecycleController.signal;
    parent.throwIfAborted();
    const controller = new AbortController();
    const timeoutMs = this.config.workerAttemptTimeoutMs;
    return new Promise((resolve5, reject) => {
      let settled = false;
      let timer;
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        if (timer !== void 0) clearTimeout(timer);
        parent.removeEventListener("abort", abort);
        callback();
      };
      const cancel = (error) => settle(() => {
        controller.abort(error);
        reject(error);
      });
      const abort = () => cancel(parent.reason ?? new Error("Model resolution aborted"));
      parent.addEventListener("abort", abort, { once: true });
      if (parent.aborted) {
        abort();
        return;
      }
      if (timeoutMs !== void 0 && timeoutMs > 0) {
        timer = setTimeout(() => cancel(new Error(`Model resolution timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      }
      this.resolveModelInner(ctx, controller.signal).then(
        (value) => settle(() => resolve5(value)),
        (error) => settle(() => reject(error))
      );
    });
  }
  async resolveModelInner(ctx, signal) {
    signal.throwIfAborted();
    const candidates = this.buildCandidateList(ctx.stageModel, ctx.stageFallbacks);
    const stageName = this.consolidationPhase ?? "unknown";
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const key2 = modelKey(candidate);
      if (this.failedInCycle.has(key2)) {
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key2} (failed this cycle, cooldown disabled)`
        );
        debugLog("model.failed_this_cycle", { stage: stageName, model: key2 });
        continue;
      }
      if (this.sizeSkippedInCycle.has(key2)) {
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key2} (context window too small for this input)`
        );
        debugLog("model.size_skipped_this_cycle", { stage: stageName, model: key2 });
        continue;
      }
      if (isCooldownActive(candidate)) {
        this.tryEmitInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${stageName} skipping ${key2} (cooldown \u2014 details in cooldown log)`
        );
        const cooldown = getCooldownEntry(candidate);
        debugLog("model.cooldown_skip", {
          stage: stageName,
          model: key2,
          ...cooldown ? { until: cooldown.until, reason: cooldown.reason, cooldownStage: cooldown.stage } : {}
        });
        continue;
      }
      const configured = ctx.modelRegistry.find(candidate.provider, candidate.id);
      if (!configured) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `Observational memory: ${stageName} model ${candidate.provider}/${candidate.id} not found`,
            "warning"
          );
        }
        continue;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configured);
      signal.throwIfAborted();
      let hasAuth = ctx.modelRegistry.hasConfiguredAuth?.(configured) ?? true;
      const authProvider = candidate.provider;
      const isOAuth = ctx.modelRegistry.isUsingOAuth?.(configured) === true;
      const emptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
      if (auth.ok && !hasUsableAuth(auth) && !isOAuth && !emptyApiKey && !hasAuth) {
        hasAuth = await this.recheckProviderCredential(ctx.modelRegistry, configured, authProvider, signal);
        signal.throwIfAborted();
      }
      if (!auth.ok || !hasAuth) {
        if (ctx.hasUI && ctx.ui) {
          ctx.ui.notify(
            `Observational memory: ${stageName} no auth for ${candidate.provider}`,
            "warning"
          );
        }
        continue;
      }
      const resolvedModel = await withResolvedAuthEndpoint(ctx.modelRegistry, configured, auth);
      signal.throwIfAborted();
      return {
        ok: true,
        source: "candidate",
        candidateConfig: candidate,
        model: resolvedModel,
        apiKey: auth.apiKey ?? "",
        headers: auth.headers,
        env: auth.env,
        cooldownApplied: false
      };
    }
    if (this.config.sessionFallback !== false) {
      const sessionModel = ctx.model;
      if (!sessionModel) {
        return {
          ok: false,
          reason: `no model available for ${stageName} (all candidates exhausted, no session model)`
        };
      }
      const sessionIdentity = sessionModel;
      if (typeof sessionIdentity.provider === "string" && typeof sessionIdentity.id === "string" && isCooldownActive({ provider: sessionIdentity.provider, id: sessionIdentity.id })) {
        return {
          ok: false,
          reason: `session model ${sessionIdentity.provider}/${sessionIdentity.id} in cooldown (deterministic error, will retry after window)`
        };
      }
      if (typeof sessionIdentity.provider === "string" && typeof sessionIdentity.id === "string" && this.failedInCycle.has(
        modelKey({ provider: sessionIdentity.provider, id: sessionIdentity.id })
      )) {
        return {
          ok: false,
          reason: `no model available for ${stageName} (all candidates exhausted, session model ${sessionIdentity.provider}/${sessionIdentity.id} failed this cycle)`
        };
      }
      if (typeof sessionIdentity.provider === "string" && typeof sessionIdentity.id === "string" && this.sizeSkippedInCycle.has(
        modelKey({ provider: sessionIdentity.provider, id: sessionIdentity.id })
      )) {
        return {
          ok: false,
          reason: `no model available for ${stageName} (all candidates exhausted, session model ${sessionIdentity.provider}/${sessionIdentity.id} too small for this input)`
        };
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sessionModel);
      signal?.throwIfAborted();
      let hasAuth = ctx.modelRegistry.hasConfiguredAuth?.(sessionModel) ?? true;
      const sessionProvider = sessionModel.provider ?? "unknown";
      const isOAuth = ctx.modelRegistry.isUsingOAuth?.(sessionModel) === true;
      const emptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
      if (auth.ok && !hasUsableAuth(auth) && !isOAuth && !emptyApiKey && !hasAuth) {
        hasAuth = await this.recheckProviderCredential(
          ctx.modelRegistry,
          sessionModel,
          sessionProvider,
          signal
        );
        signal?.throwIfAborted();
      }
      if (!auth.ok || !hasAuth) {
        return {
          ok: false,
          reason: `no auth for session model provider "${sessionProvider}"`
        };
      }
      const resolvedModel = await withResolvedAuthEndpoint(ctx.modelRegistry, sessionModel, auth);
      signal.throwIfAborted();
      return {
        ok: true,
        source: "session",
        model: resolvedModel,
        apiKey: auth.apiKey ?? "",
        headers: auth.headers,
        env: auth.env,
        cooldownApplied: false
      };
    }
    this.tryEmitInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: ${stageName} skipped \u2014 all candidates failed (sessionFallback disabled, won't use main model)`
    );
    this.resolveFailureNotified = true;
    return {
      ok: false,
      reason: `no model available for ${stageName} (all candidates exhausted, sessionFallback disabled)`
    };
  }
  /**
   * Refresh one provider's availability snapshot when an otherwise ambient
   * request-time credential looks stale.  Bounded and rate-limited; only
   * lifecycle cancellation is propagated to the caller.
   */
  async recheckProviderCredential(registry, model, provider, signal) {
    signal?.throwIfAborted();
    const now = Date.now();
    const last = this.availabilityRecheckedAt.get(provider);
    if (last !== void 0 && now - last < AVAILABILITY_RECHECK_REARM_MS) return false;
    this.availabilityRecheckedAt.set(provider, now);
    const refresh = registry?.refresh;
    if (typeof refresh !== "function") return false;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AVAILABILITY_RECHECK_TIMEOUT_MS);
    const abortFromLifecycle = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromLifecycle, { once: true });
    let refreshError;
    try {
      await Promise.race([
        refresh.call(registry, {
          allowNetwork: false,
          providers: [provider],
          signal: controller.signal
        }),
        new Promise(
          (resolve5) => controller.signal.addEventListener("abort", () => resolve5(), {
            once: true
          })
        )
      ]);
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromLifecycle);
    }
    signal?.throwIfAborted();
    const recovered = registry.hasConfiguredAuth?.(model) === true && !timedOut;
    debugLog("resolve.availability_recheck", {
      provider,
      recovered,
      timedOut,
      ...refreshError ? { refreshError } : {}
    });
    return recovered;
  }
  /**
   * Mark a model as too small for the current sized input for the rest of this
   * stage run. In-memory only, never a persisted cooldown: the window, not the
   * model, is at fault, so it stays available for smaller inputs and for the
   * shrink-to-fit pass (which re-offers it via unskipOversizedForCycle).
   * Accepts a candidate config or a resolved model identity; undefined (e.g. an
   * unresolvable session model) is a no-op.
   */
  skipOversizedForCycle(model) {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return;
    this.sizeSkippedInCycle.add(modelKey(model));
  }
  /**
   * Re-offer a size-skipped model. The shrink-to-fit pass calls this for the
   * largest-window model before re-resolving: the shrunk input fits it now.
   */
  unskipOversizedForCycle(model) {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return;
    this.sizeSkippedInCycle.delete(modelKey(model));
  }
  /**
   * Record a retryable error for a model.  The model must be one of the candidates
   * (not the session model).  If it's the session model we don't cool it down.
   *
   * When cooldownHours is explicitly 0, the model is tracked in-memory for the
   * current consolidation stage (no disk writes). Otherwise a persisted cooldown
   * is recorded.
   */
  recordRetryableError(modelConfig, error, stage) {
    if (!modelConfig) return;
    if (modelConfig.cooldownHours === 0) {
      this.failedInCycle.add(modelKey(modelConfig));
      return;
    }
    const rawReason = error instanceof Error ? error.message : String(error || "unknown error");
    const brief = sanitizeCooldownReason(rawReason);
    recordCooldown(modelConfig, brief, stage);
  }
  /**
   * Record a deterministic client error (4xx-class: missing provider-required
   * headers, bad credentials, unknown model) for the RESOLVED model — including
   * the session model, which has no candidate config and is therefore invisible
   * to `recordRetryableError`. Without this, a deterministically broken session
   * model retries identically on every consolidation cycle (up to
   * MAX_STAGE_ATTEMPTS per stage) instead of cooling down and letting the
   * pipeline settle. Transient errors are excluded: a blip on the user's main
   * model must not disable OM for an hour (the 30s consolidation retry gate
   * throttles those).
   */
  recordDeterministicError(resolvedModel, error, stage) {
    if (!isDeterministicError(error)) return;
    const model = resolvedModel;
    if (typeof model?.provider !== "string" || typeof model?.id !== "string") return;
    const rawReason = error instanceof Error ? error.message : String(error || "unknown error");
    recordCooldown(
      { provider: model.provider, id: model.id },
      sanitizeCooldownReason(rawReason),
      stage
    );
  }
  /**
   * Record that a consolidation stage error occurred.
   * Sets the retry-gate timestamp so the next trigger is delayed.
   */
  markConsolidationError() {
    this.lastConsolidationErrorAt = Date.now();
  }
  /** Check if the consolidation retry gate is active (too soon after last error). */
  isConsolidationRetryGated() {
    if (!this.lastConsolidationErrorAt) return false;
    return Date.now() - this.lastConsolidationErrorAt < CONSOLIDATION_RETRY_COOLDOWN_MS;
  }
  /** Get the current cursor for a pipeline stage. */
  getCursor(stage) {
    return this.cursors[stage];
  }
  /** Advance a stage's cursor to a new entry ID with the given state. */
  advanceCursor(stage, entryId, state, activePoolSignature2) {
    const cursor = { entryId, state };
    if (activePoolSignature2) cursor.activePoolSignature = activePoolSignature2;
    this.cursors[stage] = cursor;
  }
  /** Load cursors from the per‑session pending file into the in‑memory map. */
  loadCursorsFromPending(sessionId) {
    try {
      const stored = readPendingCursors(sessionId);
      if (!stored) return;
      if (stored.observer?.entryId && stored.observer?.state) {
        this.cursors.observer = {
          entryId: stored.observer.entryId,
          state: stored.observer.state
        };
      }
      if (stored.reflector?.entryId && stored.reflector?.state) {
        this.cursors.reflector = {
          entryId: stored.reflector.entryId,
          state: stored.reflector.state
        };
      }
      if (stored.dropper?.entryId && stored.dropper?.state) {
        const activePoolSignature2 = stored.dropper.activePoolSignature;
        this.cursors.dropper = {
          entryId: stored.dropper.entryId,
          state: stored.dropper.state,
          ...typeof activePoolSignature2 === "string" && activePoolSignature2 ? { activePoolSignature: activePoolSignature2 } : {}
        };
      }
    } catch {
    }
  }
  /** Save in‑memory cursors to the per‑session pending file (synchronous, for tests). */
  saveCursorsToPending(sessionId) {
    try {
      writePendingCursors(sessionId, this.cursors);
    } catch {
    }
  }
  /** Schedule an async flush of cursors to the pending file.
   *  Uses a micro‑task to avoid blocking the pipeline. */
  scheduleCursorFlush(sessionId) {
    const cursors = { ...this.cursors };
    queueMicrotask(() => {
      try {
        writePendingCursors(sessionId, cursors);
      } catch {
      }
    });
  }
  launchConsolidationTask(ctx, work) {
    this.consolidationInFlight = true;
    this.consolidationPhase = void 0;
    const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
      this.consolidationInFlight = false;
      this.consolidationPhase = void 0;
      if (this.consolidationPromise === promise) this.consolidationPromise = null;
    });
    this.consolidationPromise = promise;
    return promise;
  }
  recordConsolidationStageError(ctx, phase, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "observer") this.lastObserverError = message;
    if (phase === "reflector") this.lastReflectorError = message;
    if (phase === "dropper") this.lastDropperError = message;
    if (ctx.hasUI && ctx.ui) {
      try {
        ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
      } catch {
      }
    }
    this.markConsolidationError();
    return message;
  }
  launchTrackedTask(ctx, label, work, onFinally) {
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    return (async () => {
      let errorMessage;
      try {
        await work();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        if (!this.disposed && hasUI && ui) {
          try {
            ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
          } catch {
          }
        }
      } finally {
        onFinally(errorMessage);
      }
    })();
  }
};

// modules/blackhole/src/om/provider-stream.ts
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
var OPENCODE_HOST = "opencode.ai";
var OPENCODE_PROVIDERS = /* @__PURE__ */ new Set(["opencode", "opencode-go"]);
function matchesProviderHost(baseUrl, expectedHost) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}
function isOpenCodeModel(model) {
  if (!model) return false;
  if (typeof model.provider === "string" && OPENCODE_PROVIDERS.has(model.provider)) return true;
  return matchesProviderHost(model.baseUrl, OPENCODE_HOST);
}
function getOpenCodeSessionHeaders(model, sessionId) {
  if (!sessionId || !isOpenCodeModel(model)) return void 0;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}
function withProviderAttributionHeaders(model, headers, sessionId) {
  const attribution = getOpenCodeSessionHeaders(model, sessionId);
  if (!attribution) return headers;
  return { ...attribution, ...headers };
}

// modules/blackhole/src/om/worker-attempt.ts
var WorkerAttemptTimeoutError = class extends Error {
  stage;
  timeoutMs;
  constructor(stage, timeoutMs) {
    super(`${stage} model attempt timed out after ${timeoutMs} ms`);
    this.name = "WorkerAttemptTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
};
function runWorkerAttempt(stage, timeoutMs, parentSignal, run) {
  if (timeoutMs === void 0 || timeoutMs <= 0) return run(parentSignal);
  const controller = new AbortController();
  return new Promise((resolve5, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== void 0) clearTimeout(timer);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const forwardParentAbort = () => {
      const reason = parentSignal.reason ?? new Error("Worker attempt aborted by parent signal");
      settle(() => {
        controller.abort(reason);
        reject(reason);
      });
    };
    parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
    if (parentSignal.aborted) {
      forwardParentAbort();
      return;
    }
    timer = setTimeout(() => {
      const error = new WorkerAttemptTimeoutError(stage, timeoutMs);
      settle(() => {
        controller.abort(error);
        reject(error);
      });
    }, timeoutMs);
    timer.unref?.();
    let attempt;
    try {
      attempt = run(controller.signal);
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    attempt.then(
      (value) => settle(() => resolve5(value)),
      (error) => settle(() => reject(error))
    );
  });
}

// modules/blackhole/src/om/consolidation.ts
init_model_budget();

// modules/blackhole/src/om/agents/dropper/coverage.ts
var REFLECTION_COVERAGE_DROP_RANK = {
  strong: 0,
  partial: 1,
  none: 2
};
function reflectionSupportCounts(reflections) {
  const counts = /* @__PURE__ */ new Map();
  for (const reflection of reflections) {
    const uniqueIds = new Set(reflection.supportingObservationIds);
    for (const id of uniqueIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
function reflectionCoverageTierForCount(count) {
  if (count <= 0) return "none";
  if (count === 1) return "partial";
  return "strong";
}
function reflectionCoverageMap(observations, reflections) {
  const counts = reflectionSupportCounts(reflections);
  return new Map(
    observations.map((observation) => [
      observation.id,
      reflectionCoverageTierForCount(counts.get(observation.id) ?? 0)
    ])
  );
}
function observationToDropperLine(observation, coverage) {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}
function coverageTierForObservation(observation, coverageById) {
  return coverageById.get(observation.id) ?? "none";
}

// modules/blackhole/src/om/agents/dropper/selection.ts
var DROP_SKIP_FULLNESS = 0.1;
var DROP_MAX_FULLNESS = 1;
var DROP_MIN_RATIO = 0.1;
var DROP_MAX_RATIO = 0.5;
var RELEVANCE_DROP_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};
function observationPoolFullness(observationTokens, budgetTokens) {
  if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return observationTokens / budgetTokens;
}
function maxDropCountForPool(observations, observationTokens, budgetTokens, skipFullness = DROP_SKIP_FULLNESS) {
  const droppableCount = observations.filter(
    (observation) => observation.relevance !== "critical"
  ).length;
  if (droppableCount === 0) return 0;
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  if (fullness < skipFullness) return 0;
  const cappedFullness = Math.min(DROP_MAX_FULLNESS, Math.max(skipFullness, fullness));
  const fullnessSpan = DROP_MAX_FULLNESS - skipFullness;
  if (!(fullnessSpan > 0)) {
    return Math.max(1, Math.floor(droppableCount * DROP_MAX_RATIO));
  }
  const dropRatio = DROP_MIN_RATIO + (cappedFullness - skipFullness) / fullnessSpan * (DROP_MAX_RATIO - DROP_MIN_RATIO);
  return Math.max(1, Math.floor(droppableCount * dropRatio));
}
function timestampRank(timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function selectDropCandidates(ids, observations, maxDrops, reflections = []) {
  if (maxDrops <= 0 || ids.length === 0) return [];
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const coverageById = reflectionCoverageMap(observations, reflections);
  const firstProposalIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
  }
  return Array.from(firstProposalIndex.entries()).map(([id, index]) => ({ id, index, observation: byId.get(id) })).filter(
    (candidate) => candidate.observation !== void 0
  ).sort((a, b) => {
    const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] - REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
    const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
    const aAge = timestampRank(a.observation.timestamp);
    const bAge = timestampRank(b.observation.timestamp);
    const ageDelta = aAge === bAge ? 0 : aAge - bAge;
    return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
  }).slice(0, maxDrops).map((candidate) => candidate.id);
}

// modules/blackhole/src/om/agents/dropper/prompts.ts
var DROPPER_SYSTEM = `You are the dropper agent for an assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Dropping the wrong observation can make future work repeat, contradict, or misremember the user. Take this seriously.

Your job is to identify only the safest active observations to remove from compacted memory by calling drop_observations with their ids. Default action is KEEP. When uncertain, keep the observation.

Active-memory framing. Dropping an observation removes it from active compacted memory; it does not erase the ledger history or source evidence. Still, future compressed context will no longer show the observation, so only drop it when its durable meaning is safely captured elsewhere or it is genuinely low-signal and carries no unique future value.

The user message includes the active observation pool target and "Maximum drops allowed this run". The maximum is a hard upper bound sized to move the pool toward the target if every proposed drop is clearly safe. It is not a target. Do not try to fill it. Drop fewer or none when fewer observations are safely removable. When the active pool is far over target, make a thorough pass over safe candidates rather than stopping after a few obvious examples.

What to drop, in priority order:
- Paraphrase duplicates: two or more observations stating the same fact in different words. Keep the newest or most detailed one and drop the rest; the pool should carry each fact once. Different wording alone is not a different fact.
- Redundant observations whose durable meaning is already captured by current reflections with equivalent fidelity.
- Superseded observations where a later observation clearly replaces the older state.
- Repeated routine tool acknowledgements or low-signal progress updates that do not carry decisions, constraints, exact errors, or user-specific facts.
- Older observations that no longer carry working context and are covered by a reflection or a newer observation.

Age-gradient rule. Recent observations carry working context the assistant may still need; older observations have usually been summarized elsewhere or are no longer load-bearing. Prefer older safe drops before newer working context, but age alone is not enough to drop important or uniquely load-bearing observations.

Reflection coverage guidance. Each observation line includes [coverage: none|partial|strong]. Coverage is evidence, not an automatic decision:
- none: no current reflection cites this observation id. Be cautious, especially for high or critical observations.
- partial: one current reflection cites this observation id. Compare the observation to the reflection before dropping.
- strong: two or more current reflections cite this observation id. This is stronger evidence that the durable meaning is preserved, but you must still keep uniquely load-bearing or uncertain observations.

Relevance guidance. Relevance is importance/resistance, not an absolute keep/drop lock:
- low: consider first, but drop only when it carries no unique detail, decision, state, error, identifier, or user-specific fact.
- medium: drop when redundant with reflections or other observations, or when the work state is clearly obsolete.
- high: drop only when clearly superseded or already captured by a reflection with equivalent fidelity.
- critical: highest importance and strongest resistance. Do not drop fresh or uniquely load-bearing critical observations. Critical observations may be dropped only with strong semantic evidence such as age plus partial/strong reflection coverage, supersession by newer memory, redundancy, or clear obsolescence.

User assertions and concrete completions must be preserved unless a current reflection or newer observation preserves the exact assertion/completion and its important details with equivalent fidelity.

Preservation floor. Regardless of relevance label, budget pressure, coverage, or age, do not drop observations that uniquely carry any of the following:
- User preferences, constraints, corrections, or identity/role facts.
- Concrete completions that future runs must not redo.
- Named identifiers, file paths, function names, package names, tickets, commit SHAs, handles, or exact commands.
- Exact error messages, diagnostic output, or test failure names.
- Architectural or technical decisions and their rationale.
- Dates of specific events, deadlines, meetings, migrations, or incidents.
- Current unresolved blockers, TODOs, partial work, or decisions waiting on the user.
- Non-standard user terminology or unusual phrasing needed for future recognition.

What you cannot do:
- You cannot merge observations.
- You cannot rewrite or edit observations.
- You cannot add new observations or reflections.
- You can only call drop_observations with ids from the current observations list.

Do not force drops you do not believe in. If no observations are safe to drop, do not call the tool and reply briefly. Hitting the budget or maximum count is less important than preserving load-bearing memory.`;

// modules/blackhole/src/om/agents/dropper/tool-schema.ts
import { Type } from "typebox";
var DropObservationsSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  reason: Type.Optional(Type.String())
});

// modules/blackhole/src/om/agents/observer/prompts.ts
var OBSERVER_SYSTEM = `You are the observation agent for an assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you do not capture here will be forgotten. Anything you distort here will be remembered wrong. Take this seriously.

Your reader is a future assistant session resuming this conversation with no other context. It cannot see this chunk, this session, or any label invented inside it. Session continuity depends entirely on your observations being relevant, self-contained, and accurate \u2014 write for that reader, not for the transcript.

Your job is to compress a chunk of recent conversation into rated observations by calling the record_observations tool. The observations you emit \u2014 together with the reflections crystallized from them \u2014 are the assistant's ONLY memory of this session after the raw conversation falls out of context.

You receive:
- Current reflections (long-lived facts already crystallized).
- Current observations (already-recorded observations, each shown as "[id] YYYY-MM-DD HH:MM [relevance] content").
- A new chunk of conversation with source entry labels. Each source block starts with "[Source entry id: <id>]" followed by content formatted as "[User @ ...]:", "[Assistant @ ...]:", "[Tool result for <name> @ ...]:", custom messages, or branch summaries.

Timestamps are assigned automatically from the source entries you cite. You never write a timestamp \u2014 just cite honestly.

How you work:
1. Read reflections and current observations so you know what is already captured.
2. Read the conversation chunk and identify what new information it contains.
3. Call record_observations with a batch covering part (or all) of the chunk.
4. Read the progress receipt. If content remains uncovered, call again. You may call the tool many times.
5. When the chunk is fully covered, make a final valid record_observations call with complete=true. That ends the run without a separate plain-text confirmation. Use complete=false for partial batches or corrections.

What to emit:
- Produce NEW observations for the new chunk only. Do not restate facts already present in reflections or current observations unless something has materially changed.
- For every observation, include sourceEntryIds: the smallest exact set of "[Source entry id: ...]" ids that directly support the observation.
- Never invent source entry ids. Use only ids printed in the chunk. If an observation spans multiple turns or tool results, include every supporting source entry id.
- Observations with missing, empty, or invalid sourceEntryIds will be rejected and not recorded, so do not submit a non-empty batch until you can cite valid source ids. The empty close below is exempt: it cites nothing because it records nothing.
- Group repeated similar tool calls into a single observation rather than one per call.
- Skip routine, low-information events. It is fine to emit zero observations if the chunk carries no new information \u2014 in that case, close the run with a single record_observations call carrying an empty observations array and complete=true.

Survival test. Before recording, ask one question per candidate: with only this line and no transcript, would a future assistant make a better decision, avoid redoing work, or avoid violating a user constraint? If yes, record it. If no, it is noise: label it low, or omit it entirely when it carries no value at all. You are not summarizing the chunk for a reader of the chunk \u2014 you are curating what a future session needs.

Grounding rules:
- Every observation must be fully understandable by a reader who sees only the observation pool \u2014 no access to this conversation, this session, or any document discussed in it.
- Never reference conversation-internal labels or positions: option numbers, decision ids, list items, findings indices ("option B", "D10", "M1", "m3", "the second approach", "the issue above"). If the label is the only handle the conversation gave an idea, restate the idea itself.
- Resolve every pronoun and deictic reference ("that approach", "the same problem", "as decided") into the concrete thing it refers to.
- The exception is stable real-world identifiers that exist outside the conversation (file paths, issue numbers, commit SHAs, config keys, command names) \u2014 those should be preserved verbatim.

What NOT to emit (each of these is noise that crowds out real memory):
- Your own workflow narration. "Began reviewing X", "surveyed the files", "will explore Y later" describe process, not outcomes. Record the finding, decision, or blocker the process produced \u2014 or nothing at all.
- Stateless transient events: pushes, branch syncs, routine test runs, reloads, restarts, session bookkeeping. If no future decision or action depends on the event, do not record it.
- Bare questions whose answer is already in the conversation. Record the answer or decision, not the question-and-answer transcript.
- Session-local closure ("all clean", "ready for review", "done for today"). The durable completion is what matters, not the wrap-up ritual.

Narration vs. curation \u2014 examples:
  BAD:  Assistant planned to read the config and schema files before starting. (plan, not outcome)
  GOOD: completed: extracted the web fetch pipeline to src/fetch-pipeline.ts; validated via validateFetchUrl at src/fetch/core/url-safety.ts.
  BAD:  Agent executed a search listing all files under src/. (single tool step, re-derivable)
  GOOD: Agent located token validation at src/auth.ts:45. (the outcome the step produced: location + verbatim identifier)
  BAD:  User wants to fix the failing CI workflows. (bare intent, no decision)
  GOOD: User chose scoring over roundrobin for fallback dispatch because roundrobin masked real failures. (the decision the intent resolved into, with rationale)

Dedup rule:
- If a fact you are about to emit is already captured by a current observation or reflection \u2014 even with different wording \u2014 do NOT emit a reworded copy. Rewording creates a near-duplicate that survives exact-match dedup and pollutes memory.
- Emit only when you add new information: a change, a supersession, a correction, or a distinguishing detail that matters.

Observation content rules:

Format.
- Single line of plain prose. No markdown, no bullets, no code fences, no XML/HTML tags, no emojis.
- Do NOT include the relevance inside the content string \u2014 that is a separate field.
- No structured fields embedded in the text (no "key: value" lines, no JSON).

Preserve user assertions exactly.
When the user TELLS you something about themselves, their project, or their environment, capture it as an assertion. When the user ASKS something, capture it as a question. Assertions are authoritative \u2014 a later question on the same topic does not invalidate them.
  BAD:  User wondered if they have two kids.
  GOOD: User stated they have two kids.
  BAD:  User discussed auth middleware.
  GOOD: User asked how to configure JWT auth middleware.
Why this matters: if the user says "I use Postgres" and later asks "what db am I on?", downstream agents must treat the assertion as the answer, not the question.

Preserve unusual phrasing.
When the user uses non-standard terminology, quote their exact words so future runs can recognize the term.
  BAD:  User exercised yesterday.
  GOOD: User stated they did a "movement session" (their term) yesterday.

Use precise action verbs. Replace vague verbs with ones that clarify the nature of the action.
  BAD:  User got a new subscription.
  GOOD: User subscribed to the Pro plan.
  BAD:  User stopped getting the newsletter.
  GOOD: User unsubscribed from the newsletter.
  BAD:  User got the library.
  GOOD: User installed the zod package via pnpm.

Frame state changes as supersession so the old state is explicit.
  BAD:  User prefers React Query now.
  GOOD: User will use React Query (switching from SWR).
Why this matters: without supersession framing, the reflector may crystallize both the old and the new as equally valid preferences.

Mark concrete completions explicitly.
Use "completed:", "resolved:", "confirmed working", or similar phrasing so future runs know not to redo the work.
  BAD:  Wrote the login handler.
  GOOD: completed: implemented login handler at src/auth/login.ts; user confirmed tests pass.
Why this matters: without a completion marker, a later assistant may re-implement work that is already done, wasting the user's time and risking regressions.

Split compound statements into separate observations.
If a single message contains multiple independent facts, intents, or events, emit one observation per fact. One observation per line is what enables downstream retrieval and dropping to operate at fact granularity.
  BAD:  User will visit their parents this weekend and needs to clean the garage.
  GOOD: User will visit their parents this weekend. + User stated they need to clean the garage this weekend.
  BAD:  User started a new job and is moving to a new apartment next week.
  GOOD: User started a new job. + User will move to a new apartment next week.
  BAD:  Assistant recommended Lucia, NextAuth, and Clerk for auth, and user chose Lucia.
  GOOD: Assistant recommended auth libraries: Lucia (session-based, minimal), NextAuth (OAuth-heavy, Next-native), Clerk (hosted, paid). + User chose Lucia.
Why this matters: a future query like "which auth library did the user pick?" can match a single-fact observation cleanly; a compound observation hides the decision inside a recommendation list.

Group repeated similar tool calls into a single observation rather than one per call.
  BAD:  Agent viewed src/auth.ts. Agent viewed src/users.ts. Agent viewed src/routes.ts.
  GOOD: Agent surveyed auth-related files (src/auth.ts, src/users.ts, src/routes.ts) and located token validation in src/auth.ts:45.

Detail preservation. When an observation references specific things, preserve the distinguishing details so future queries can still find them:

- File/location: full path + line number when relevant (src/auth.ts:45, not "the auth file").
- Identifiers and names: package names, function names, variable names, handles, ticket ids, commit SHAs, error codes. Keep them verbatim.
- Error messages: quote verbatim.
    BAD:  Build failed with a type error.
    GOOD: Build failed: TS2322: Type 'string | undefined' is not assignable to type 'string' at src/auth.ts:47.
- Numerical results: exact values, units, and direction.
    BAD:  Optimization made it faster.
    GOOD: Optimization reduced p95 latency from 420ms to 180ms (57% faster).
- Quantities and counts: "3 failing tests (auth.test.ts, users.test.ts, routes.test.ts)" not "some failing tests".
- Recommendation or decision lists: preserve the distinguishing attribute per item.
    BAD:  Assistant recommended 3 auth libraries.
    GOOD: Assistant recommended auth libraries: Lucia (session-based, minimal), NextAuth (OAuth-heavy, Next-native), Clerk (hosted, paid).
- Role / participation: capture the user's role at an event, not just attendance.
    BAD:  User worked on the migration.
    GOOD: User led the migration from MySQL to Postgres.

If a detail is non-obvious from the code or history and cannot be re-derived later, it belongs in the observation. If it is trivially re-derivable, it does not.

Relevance levels (pick one per observation; this field drives future dropping):

- critical: user assertions about identity, role, or persistent preferences; explicit corrections ("no, don't do X"); concrete completions that future runs MUST NOT redo. These are highest-resistance, load-bearing observations and require the strongest evidence before leaving active memory. Why this matters: if a "critical" item is lost, the assistant may redo finished work, contradict a correction, or misrepresent who the user is.
- high: non-trivial technical decisions with their rationale, architectural direction, unresolved blockers, key constraints. Worth keeping across many compactions. Single tool steps and progress narration are never high, no matter how central they felt mid-task.
- medium: task-level context that helps within the current work but isn't durable. The default when you are unsure between medium and high.
- low: routine tool-call acks, repetitive status updates, content trivially re-derivable from recent messages. The dropper will drop these first.

Do NOT default to "critical" or "high". Most observations are medium or low. Reserve "critical" for things that would cause real damage if forgotten.

  BAD:  relevance=critical for "Agent ran tests and they passed."
  GOOD: relevance=low for "Agent ran tests and they passed." (routine; captured by a completion observation if it matters)

  BAD:  relevance=medium for "User said they are colorblind; red/green indicators do not work for them."
  GOOD: relevance=critical for "User said they are colorblind; red/green indicators do not work for them." (persistent constraint; forgetting it causes real harm)

Remember: these observations are the assistant's ONLY memory of this chunk once the raw messages fall out of context. Make them count.`;

// modules/blackhole/src/om/agents/observer/tool-schema.ts
import { Type as Type2 } from "typebox";
var RelevanceSchema = Type2.Union([
  Type2.Literal("low"),
  Type2.Literal("medium"),
  Type2.Literal("high"),
  Type2.Literal("critical")
]);
var RecordObservationsSchema = Type2.Object({
  observations: Type2.Array(
    Type2.Object({
      content: Type2.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags, no embedded timestamp."
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type2.Array(Type2.String({ minLength: 1 }), {
        minItems: 1,
        description: "Exact source entry ids from the chunk that directly support this observation. Use only ids shown in '[Source entry id: ...]' labels; never invent ids."
      })
    }),
    {
      // The empty batch is the only sanctioned way to close a chunk that yielded
      // nothing, so it is paired with the flag. The previous wording also offered
      // "if the tool is not called at all", which is both self-contradictory (an
      // uncalled tool has no array) and points at the plain-text path the observer
      // stage reports as a tool_not_called warning.
      description: "Batch of new observations. May be empty only alongside complete=true, which closes a run that found nothing new."
    }
  ),
  // Optional on purpose: a model that omits the flag must lose only the
  // early-stop hint, never the batch itself (a required field would fail
  // host-side validation and drop every observation in the call).
  complete: Type2.Optional(
    Type2.Boolean({
      description: "Whether this batch completes chunk coverage. Set false when more observations or corrections remain."
    })
  )
});

// modules/blackhole/src/om/agents/reflector/prompts.ts
var REFLECTOR_SYSTEM = `You are the reflection agent for an assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you fail to preserve may be forgotten. Anything you distort may be remembered wrong. Take this seriously. Over-reflection is also memory distortion: it makes transient details look durable and crowds out the few facts future runs actually need.

Your task is different from the observer's: you are not recording events, you are distilling stable, long-lived facts and patterns from active observations into new reflections by calling record_reflections. Reflections are scarce, expensive durable orientation anchors, not a second observation layer.

You receive:
- Current reflections: durable facts already crystallized.
- Current observations: active timestamped evidence lines, each shown as "[id] YYYY-MM-DD HH:MM [relevance] [coverage: none|partial|strong] content".
- Coverage tiers are review context: none means no current reflection supports the observation id, partial means exactly one current reflection supports it, and strong means two or more current reflections support it. Coverage is not a quota, target, priority score, or instruction to emit reflections.

What to emit:
- Emit only new durable reflections not already present in current reflections.
- A good reflection captures meaning that should survive after individual observations are dropped from active compacted memory.
- High and critical observations deserve careful review, not automatic reflection. Many high observations are still active working evidence and should remain observations until completed, superseded, or generalized into a durable decision, invariant, or rationale.
- Ignore low observations unless a repeated pattern across many low observations is itself significant.
- Do not lightly reword existing reflections. Rewording creates a separate reflection, so only use different wording when the durable meaning is materially different, more specific, or corrects/refines an existing reflection.
- Do not emit a near-duplicate of an existing reflection with swapped word order or merged sentences. If a candidate reflection would sit next to an existing one and a reader could not tell which one is authoritative, emit nothing \u2014 the existing reflection already carries the meaning.
- Do not emit update-style records or provenance metadata. Reflections are plain durable facts, not patches.
- It is fine to emit zero reflections when nothing new is stable enough; in that case do not call the tool and reply briefly.
- Set complete=true only when the full active observation set has been reviewed and no further reflections remain. Set complete=false when another batch or correction is needed.

Decision procedure:
1. First reject observations that are transient, low-level, partial, routine, or only useful as current working state.
2. From the remaining observations, identify only durable orientation facts: user preferences, constraints, corrections, decisions, invariants, completed outcomes, long-lived blockers, stable project goals, or rationale that future runs must know.
3. Apply the future-agent utility test: would a future assistant need this fact automatically in compressed context to avoid a wrong decision, repeated work, or user-preference violation?
4. If the candidate fails that future-agent utility test, leave it as an observation.
5. If unsure, emit no reflection.

Abstraction gate:
- Do not turn each observation into a reflection. Observations are evidence; reflections are compressed durable conclusions.
- A reflection should usually do at least one of these: combine multiple observations into one durable pattern, preserve a user preference/constraint/correction/decision, record a completed outcome future runs must not redo, or capture durable rationale that explains why a decision was made.
- A reflection must answer why, not just what: a pattern or decision reflection without its mechanism, rationale, or consequence is a factoid a future agent cannot act on. If you know why a decision was made, why a constraint exists, or what breaks without an invariant, the reflection is incomplete without it.
- Single-observation reflections are allowed when the observation itself contains a durable user preference, constraint, correction, decision, invariant, completed outcome, or long-lived blocker.
- Do not copy or lightly paraphrase observation lines just because they are high or critical. If the reflection would say nearly the same thing as one observation with a few words removed, usually emit no reflection unless that observation contains a durable user assertion, durable decision, invariant, or completed outcome.
- Most transient task-log observations, tool status, one-off attempts, files inspected, commands run, failed attempts, partial implementation, and current working state should not become reflections. Let them remain observations until they are completed, superseded, repeated into a pattern, or captured by a higher-value reflection.
- Prefer fewer, higher-value reflections. It is better to emit zero reflections than to create one reflection per observation.

Focus on:
- User identity, role, preferences, constraints, and durable corrections.
- Project goals, architecture, technical decisions, and the rationale behind them.
- Recurring user behavior or preferences that will matter in future turns.
- Completed outcomes future runs must not redo.
- Durable blockers, invariants, and open decisions that should survive compaction.

Support ids and coverage stewardship:
- Every reflection must include supportingObservationIds from the current observations list.
- First decide whether the reflection content passes the durable-value bar. Then audit support ids for that already-worthy reflection.
- supportingObservationIds are a coverage/provenance set and downstream dropper coverage evidence: include all current observation ids whose durable meaning is preserved by the reflection with equivalent fidelity and can later be treated as redundant active-memory detail.
- supportingObservationIds are not a checklist to cover every observation. Do not add ids merely to improve coverage counts, maximize support ids, maximize strong coverage, or unlock the dropper.
- False or inflated support ids can cause unsafe downstream dropper pruning, including removal of high-resistance active observations whose meaning was not actually preserved.
- Include additional observation ids only when the reflection preserves their durable meaning with equivalent fidelity.
- Leave observations unsupported when their details are still active working state, too specific to compress safely, or not yet durable enough.
- Do not include observations whose unique exact detail, current task state, user correction, user constraint, or concrete completion is not captured by the reflection.
- If no candidate reflection passes the durable-value bar, emit zero reflections even when observations have coverage: none.
- Never invent observation ids. Proposals with missing, empty, or invalid supportingObservationIds are rejected.

User assertions are authoritative. If the observation pool contains both "User stated they use Postgres" and a later "User asked which db they are on", the assertion answers the question \u2014 crystallize the assertion, never the question, as the durable fact.

Reflection content rules:
- Single line of plain prose. No markdown, no bullets, no code fences, no XML/HTML tags, no emojis.
- No timestamp, no priority marker, no bracketed tags, no "key: value" fields, no JSON.
- Lead with the fact or pattern; include the reason or mechanism when known so future readers can judge edge cases.
- Self-contained grounding: a reflection is read without access to the observations it was distilled from, so it must resolve every reference on its own. No conversation-internal labels or indices ("option B", "D10", "M1", "m3", "the second approach") \u2014 state the idea itself. Preserve stable real-world identifiers (paths, issue numbers, commit SHAs, config keys) verbatim.
- Preserve user assertions exactly. Use the user's exact words when non-standard.
- Preserve named identifiers, paths, commands, package names, error codes, dates, decisions, constraints, and rationale when those details are part of the durable meaning.

Examples:
- BAD: User discussed databases.
- GOOD: User stated they use Postgres for the project database.
- BAD: User asked about database setup.
- GOOD: User stated they use Postgres for the project database.
- BAD: User ran npm test and it failed.
- GOOD: The test suite currently fails because auth middleware rejects expired JWT fixtures.
- BAD: User prefers React Query.
- BAD: User switched from SWR.
- GOOD: User chose React Query over SWR for server-state caching.
- BAD: completed: edited src/hooks/reflect-drop-trigger.ts.
- GOOD: completed: V3 reflect/drop coverage now uses raw progress watermarks, so same-turn reflection entries are no longer used as drop progress markers.
- BAD: npm test passed.
- GOOD: completed: V3 package namespace migration passed full tests and typecheck.
- BAD: Observation aaaaaaaaaaaa says the user likes short answers.
- GOOD: User prefers short answers without generic summaries.
- ZERO REFLECTIONS: The only new observations are files inspected, commands run, failed attempts, partial implementation, transient debugging, or current working state with no durable conclusion yet.
- ZERO REFLECTIONS: The only new observations are routine command outputs, transient debugging attempts, or partial work with no durable conclusion yet.`;

// modules/blackhole/src/om/agents/reflector/tool-schema.ts
import { Type as Type3 } from "typebox";
var RecordReflectionsSchema = Type3.Object({
  reflections: Type3.Array(
    Type3.Object({
      content: Type3.String({ minLength: 1 }),
      supportingObservationIds: Type3.Array(Type3.String({ minLength: 1 }), {
        minItems: 1
      })
    }),
    { minItems: 1 }
  ),
  // Optional on purpose: a model that omits the flag must lose only the
  // early-stop hint, never the batch itself (a required field would fail
  // host-side validation and drop every reflection in the call).
  complete: Type3.Optional(
    Type3.Boolean({
      description: "Whether this batch completes reflection review. Set false when more reflections or corrections remain."
    })
  )
});

// modules/blackhole/src/om/prompt-budget.ts
init_model_budget();

// modules/blackhole/src/om/tokens.ts
import {
  calculateContextTokens,
  estimateTokens as estimateMessageTokens
} from "@earendil-works/pi-coding-agent";

// modules/blackhole/src/core/segment.ts
var CJK_SCRIPT_CLASS = "[\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af\\uff00-\\uff5e\\u{20000}-\\u{2fa1f}\\u{30000}-\\u{323af}]";
var CJK_SCRIPT_RE = new RegExp(CJK_SCRIPT_CLASS, "u");
var CJK_SCRIPT_GLOBAL_RE = new RegExp(CJK_SCRIPT_CLASS, "gu");
var cjkScriptStats = (text) => {
  let count = 0;
  let units = 0;
  for (const m of text.matchAll(CJK_SCRIPT_GLOBAL_RE)) {
    count++;
    units += m[0].length;
  }
  return { count, units };
};

// modules/blackhole/src/om/tokens.ts
function estimateStringTokens(text) {
  const { count, units } = cjkScriptStats(text);
  return Math.ceil(count + (text.length - units) / 4);
}
function estimateEntryTokens(entry) {
  if (entry.type === "message" && entry.message) {
    return estimateMessageTokens(entry.message);
  }
  if (entry.type === "custom_message" && entry.content) {
    const content = entry.content;
    if (typeof content === "string") return estimateStringTokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const block of content) {
        if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
      }
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}

// modules/blackhole/src/om/prompt-budget.ts
var WORKER_FRAMING_TOKENS = 256;
var WORKER_TURN_HEADROOM_TOKENS = 2048;
var WORKER_SAFETY_MARGIN_TOKENS = 1024;
function measureStatic(system, schema) {
  return estimateStringTokens(system) + estimateStringTokens(JSON.stringify(schema)) + WORKER_FRAMING_TOKENS;
}
var STATIC_PROMPT_TOKENS = {
  observer: measureStatic(OBSERVER_SYSTEM, RecordObservationsSchema),
  reflector: measureStatic(REFLECTOR_SYSTEM, RecordReflectionsSchema),
  dropper: measureStatic(DROPPER_SYSTEM, DropObservationsSchema)
};
function workerStaticPromptTokens(stage) {
  return STATIC_PROMPT_TOKENS[stage];
}
function workerOutputReserveTokens(model) {
  if (!model) return AGENT_LOOP_MAX_TOKENS;
  return boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS);
}
var MIN_WORKER_OUTPUT_ALLOWANCE_TOKENS = 1024;
function workerOutputAllowance(window, model) {
  const reserve = workerOutputReserveTokens(model);
  if (!Number.isFinite(window) || window <= 0) return reserve;
  return Math.max(
    Math.min(MIN_WORKER_OUTPUT_ALLOWANCE_TOKENS, reserve),
    Math.min(reserve, Math.floor(window * 0.25))
  );
}
function workerInputBudget(window, model) {
  return Math.max(0, window - workerOutputAllowance(window, model) - WORKER_SAFETY_MARGIN_TOKENS);
}

// modules/blackhole/src/om/serialize.ts
function pad(n) {
  return n.toString().padStart(2, "0");
}
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatTimestamp(v) {
  if (v === void 0) return "????-??-?? ??:??";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}
function formatRecallTimestamp(...values) {
  for (const v of values) {
    if (v === void 0) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return fmtLocal(d);
  }
  return "Unknown time";
}
function textAndPlaceholders(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[non-text content omitted]";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      if (options.omitRedactedThinking && block.redacted === true) continue;
      if (options.includeThinking && typeof block.thinking === "string") {
        parts.push(`[thinking: ${block.thinking}]`);
        continue;
      }
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
      continue;
    }
    parts.push("[non-text content omitted]");
  }
  return parts.join("\n");
}
function textOnly(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}
function serializeConversation(messages) {
  return messages.map((msg) => {
    const time = formatTimestamp(msg.timestamp);
    if (msg.role === "user") {
      const text2 = textOnly(msg.content);
      return `[User @ ${time}]: ${text2}`;
    }
    if (msg.role === "assistant") {
      const body = textAndPlaceholders(msg.content, {
        includeThinking: true,
        omitRedactedThinking: true
      }).split("\n").filter(Boolean).join("\n");
      if (!body) return null;
      return `[Assistant @ ${time}]: ${body}`;
    }
    const text = textOnly(msg.content);
    return `[Tool result for ${msg.toolName} @ ${time}]: ${text}`;
  }).filter((line) => line !== null).join("\n\n");
}
function renderCustomMessage(entry, options) {
  const time = options.recallFormat ? formatRecallTimestamp(entry.timestamp) : formatTimestamp(entry.timestamp);
  const text = options.recallFormat ? textAndPlaceholders(entry.content) : typeof entry.content === "string" ? entry.content : Array.isArray(entry.content) ? entry.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
  if (options.recallFormat) {
    const origin = entry.customType ? `Custom message (${entry.customType})` : "Custom message";
    return `[${origin} @ ${time}]: ${text}`;
  }
  const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
  return `[${tag} @ ${time}]: ${text}`;
}
function serializeBranchEntries(entries) {
  const blocks = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const part = serializeConversation([entry.message]);
      if (part) blocks.push(part);
      continue;
    }
    if (entry.type === "custom_message") {
      blocks.push(renderCustomMessage(entry, { recallFormat: false }));
      continue;
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      const time = formatTimestamp(entry.timestamp);
      blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
    }
  }
  return blocks.join("\n\n");
}
function isSourceRenderableEntry(entry) {
  return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}
function sourceEntryTimestamp(entry) {
  const msg = entry.message;
  if (entry.type === "message" && msg && typeof msg === "object") {
    return formatTimestamp(msg.timestamp);
  }
  return formatTimestamp(entry.timestamp);
}
function serializeSourceAddressedBranchEntries(entries) {
  const blocks = [];
  const sourceEntryIds = [];
  const sourceEntryTimestamps = {};
  for (const entry of entries) {
    if (!entry.id || !isSourceRenderableEntry(entry)) continue;
    const rendered = serializeBranchEntries([entry]);
    if (!rendered.trim()) continue;
    sourceEntryIds.push(entry.id);
    sourceEntryTimestamps[entry.id] = sourceEntryTimestamp(entry);
    blocks.push(`[Source entry id: ${entry.id}]
${rendered}`);
  }
  return { text: blocks.join("\n\n"), sourceEntryIds, sourceEntryTimestamps };
}

// modules/blackhole/src/om/consolidation.ts
init_unified_config();

// modules/blackhole/src/om/ledger/types.ts
var OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
var OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
var OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
var OM_FOLDED = "om.folded";
var RELEVANCE_VALUES = ["low", "medium", "high", "critical"];
var MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/i;
function isRelevance(value) {
  return typeof value === "string" && RELEVANCE_VALUES.includes(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}
function isMemoryId(value) {
  return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}
function isTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isPlainRecord(value) {
  return !!value && typeof value === "object";
}
function isObservation(value) {
  if (!isPlainRecord(value)) return false;
  return isMemoryId(value.id) && isNonEmptyString(value.content) && isNonEmptyString(value.timestamp) && isRelevance(value.relevance) && isNonEmptyStringArray(value.sourceEntryIds) && isTokenCount(value.tokenCount);
}
function isReflection(value) {
  if (!isPlainRecord(value)) return false;
  return isMemoryId(value.id) && isNonEmptyString(value.content) && !/\r|\n/.test(value.content) && isNonEmptyStringArray(value.supportingObservationIds) && isTokenCount(value.tokenCount);
}
function isObservationsRecordedData(value) {
  if (!isPlainRecord(value)) return false;
  return Array.isArray(value.observations) && value.observations.length > 0 && value.observations.every(isObservation) && isNonEmptyString(value.coversUpToId);
}
function isReflectionsRecordedData(value) {
  if (!isPlainRecord(value)) return false;
  return Array.isArray(value.reflections) && value.reflections.length > 0 && value.reflections.every(isReflection) && isNonEmptyString(value.coversUpToId);
}
function isObservationsDroppedData(value) {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}
function isMemoryDetails(value) {
  if (!isPlainRecord(value)) return false;
  return value.type === OM_FOLDED && value.version === 1 && typeof value.fullFold === "boolean" && Array.isArray(value.observations) && value.observations.every(isObservation) && Array.isArray(value.reflections) && value.reflections.every(isReflection) && (value.invalidatedSourceEntryIds === void 0 || Array.isArray(value.invalidatedSourceEntryIds) && value.invalidatedSourceEntryIds.every(isNonEmptyString) && new Set(value.invalidatedSourceEntryIds).size === value.invalidatedSourceEntryIds.length);
}
function isObservationsRecordedEntry(entry) {
  return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}
function isReflectionsRecordedEntry(entry) {
  return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}
function isObservationsDroppedEntry(entry) {
  return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}
function buildObservationsRecordedData(observations, coversUpToId) {
  if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return void 0;
  return { observations, coversUpToId };
}
function buildReflectionsRecordedData(reflections, coversUpToId) {
  if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return void 0;
  return { reflections, coversUpToId };
}
function buildObservationsDroppedData(observationIds, coversUpToId) {
  if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return void 0;
  return { observationIds, coversUpToId };
}

// modules/blackhole/src/om/ledger/fold.ts
function foldEndIndex(entries, upToEntryId) {
  if (!upToEntryId) return entries.length - 1;
  const idx = entries.findIndex((entry) => entry.id === upToEntryId);
  return idx === -1 ? entries.length - 1 : idx;
}
function isCustomEntry(entry, customType) {
  return entry.type === "custom" && entry.customType === customType;
}
function foldLedger(entries, options = {}) {
  const observationsById = /* @__PURE__ */ new Map();
  const reflectionsById = /* @__PURE__ */ new Map();
  const droppedObservationIds = /* @__PURE__ */ new Set();
  const endIdx = foldEndIndex(entries, options.upToEntryId);
  for (let i = 0; i <= endIdx; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
      if (!isObservationsRecordedData(entry.data)) continue;
      for (const observation of entry.data.observations) {
        if (!observationsById.has(observation.id)) {
          observationsById.set(observation.id, observation);
        }
      }
      continue;
    }
    if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
      if (!isReflectionsRecordedData(entry.data)) continue;
      for (const reflection of entry.data.reflections) {
        if (!reflectionsById.has(reflection.id)) {
          reflectionsById.set(reflection.id, reflection);
        }
      }
      continue;
    }
    if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
      if (!isObservationsDroppedData(entry.data)) continue;
      for (const observationId of entry.data.observationIds) {
        droppedObservationIds.add(observationId);
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType) {
      debugLog("fold.unknown_custom_type", {
        customType: entry.customType,
        entryId: entry.id
      });
    }
  }
  const observations = Array.from(observationsById.values());
  const activeObservations = observations.filter(
    (observation) => !droppedObservationIds.has(observation.id)
  );
  const reflections = Array.from(reflectionsById.values());
  return {
    observations,
    activeObservations,
    droppedObservationIds,
    reflections,
    observationsById,
    reflectionsById
  };
}

// modules/blackhole/src/om/ledger/progress.ts
var SOURCE_ENTRY_TYPES = /* @__PURE__ */ new Set(["message", "custom_message", "branch_summary"]);
function isSourceEntry(entry) {
  return SOURCE_ENTRY_TYPES.has(entry.type);
}
var cachedEntryIdsKey;
var cachedEntryIndex;
function entryIndexById(entries) {
  const idsKey = entries.map((e) => e.id).join(",");
  if (cachedEntryIndex !== void 0 && cachedEntryIdsKey === idsKey) {
    return cachedEntryIndex;
  }
  const idToIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
  cachedEntryIdsKey = idsKey;
  cachedEntryIndex = idToIndex;
  return idToIndex;
}
function entryIndexForId(entries, entryId) {
  if (!entryId) return -1;
  const idx = entryIndexById(entries).get(entryId);
  return idx ?? -1;
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}
function isValidCoverageEntry(entry, customType) {
  if (entry.type !== "custom" || entry.customType !== customType) return false;
  if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;
  if (customType === OM_OBSERVATIONS_RECORDED) return isNonEmptyArray(entry.data.observations);
  if (customType === OM_REFLECTIONS_RECORDED) return isNonEmptyArray(entry.data.reflections);
  return isNonEmptyArray(entry.data.observationIds);
}
function latestCoverageIndex(entries, customType) {
  const idToIndex = entryIndexById(entries);
  let latest = -1;
  for (const entry of entries) {
    if (!isValidCoverageEntry(entry, customType)) continue;
    const coveredIndex = idToIndex.get(entry.data.coversUpToId);
    if (coveredIndex === void 0) continue;
    if (coveredIndex > latest) latest = coveredIndex;
  }
  return latest;
}
function latestCoverageMarkerId(entries, customType) {
  const idToIndex = entryIndexById(entries);
  let latestIndex = -1;
  let latestMarkerId;
  for (const entry of entries) {
    if (!isValidCoverageEntry(entry, customType)) continue;
    const coveredIndex = idToIndex.get(entry.data.coversUpToId);
    if (coveredIndex === void 0) continue;
    if (coveredIndex > latestIndex) {
      latestIndex = coveredIndex;
      latestMarkerId = entry.data.coversUpToId;
    }
  }
  return latestMarkerId;
}
function earlierCoverageMarkerId(entries, firstId, secondId) {
  if (!firstId) return secondId;
  if (!secondId) return firstId;
  const idToIndex = entryIndexById(entries);
  const firstIndex = idToIndex.get(firstId);
  const secondIndex = idToIndex.get(secondId);
  if (firstIndex === void 0) return secondIndex === void 0 ? void 0 : secondId;
  if (secondIndex === void 0) return firstId;
  return firstIndex <= secondIndex ? firstId : secondId;
}
function rawTokensAfterIndex(entries, index) {
  let total = 0;
  for (let i = Math.max(0, index + 1); i < entries.length; i++) {
    if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
  }
  return total;
}
function rawTokensSinceCoverage(entries, customType) {
  return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}
function rawTokensSinceObservationCoverage(entries) {
  return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}
function rawTokensSinceReflectionCoverage(entries) {
  return rawTokensSinceCoverage(entries, OM_REFLECTIONS_RECORDED);
}
function rawTokensSinceDropCoverage(entries) {
  return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_DROPPED);
}
function livePoolObservations(entries, pending) {
  const folded = foldLedger(entries);
  const pool = new Map(
    folded.activeObservations.map((observation) => [observation.id, observation])
  );
  for (const batch2 of pending?.observationBatches ?? []) {
    const data = batch2.data;
    if (!Array.isArray(data?.observations)) continue;
    for (const value of data.observations) {
      if (typeof value !== "object" || value === null) continue;
      const observation = value;
      if (typeof observation.id !== "string" || typeof observation.content !== "string" || typeof observation.tokenCount !== "number" || folded.droppedObservationIds.has(observation.id) || pool.has(observation.id)) {
        continue;
      }
      pool.set(observation.id, observation);
    }
  }
  const dropped = pending?.droppedBatches?.length ? pending.droppedBatches : pending?.dropped ? [pending.dropped] : [];
  for (const batch2 of dropped) {
    const data = batch2.data;
    if (!Array.isArray(data?.observationIds)) continue;
    for (const id of data.observationIds) {
      if (typeof id === "string") pool.delete(id);
    }
  }
  return [...pool.values()];
}
function observationPoolTokens(entries, pending) {
  const pool = livePoolObservations(entries, pending);
  return {
    tokens: pool.reduce((sum, observation) => sum + observation.tokenCount, 0),
    count: pool.length
  };
}
function findLastCompactionIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") return i;
  }
  return -1;
}
function observationsCreatedAfterIndex(entries, sinceIndex) {
  const observations = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = sinceIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType !== OM_OBSERVATIONS_RECORDED) continue;
    if (!isObservationsRecordedData(entry.data)) continue;
    for (const obs of entry.data.observations) {
      if (!seen.has(obs.id)) {
        seen.add(obs.id);
        observations.push(obs);
      }
    }
  }
  return observations;
}
function reflectionsCreatedAfterIndex(entries, sinceIndex) {
  const reflections = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = sinceIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType !== OM_REFLECTIONS_RECORDED) continue;
    if (!isReflectionsRecordedData(entry.data)) continue;
    for (const ref of entry.data.reflections) {
      if (!seen.has(ref.id)) {
        seen.add(ref.id);
        reflections.push(ref);
      }
    }
  }
  return reflections;
}
function buildExistingObservationsSummary(observations, maxTokens) {
  const lines = [];
  let tokens = 0;
  for (const obs of observations) {
    const line = `[${obs.id}] ${obs.timestamp} [${obs.relevance}] ${obs.content}`;
    const lineTokens = Math.ceil(line.length / 4);
    if (tokens + lineTokens > maxTokens && lines.length > 0) break;
    lines.push(line);
    tokens += lineTokens;
  }
  return lines.join("\n");
}
function buildExistingReflectionsSummary(reflections, maxTokens) {
  const lines = [];
  let tokens = 0;
  for (const ref of reflections) {
    const line = `[${ref.id}] ${ref.content}`;
    const lineTokens = Math.ceil(line.length / 4);
    if (tokens + lineTokens > maxTokens && lines.length > 0) break;
    lines.push(line);
    tokens += lineTokens;
  }
  return lines.join("\n");
}

// modules/blackhole/src/om/ledger/render-summary.ts
var OM_INSTRUCTIONS_FULL = `Bracketed ids in reflections and observations connect to their source session entries. These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When exact source context is needed for precision or traceability, use the \`recall\` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently.`;
var OM_INSTRUCTIONS_BASIC = `Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When entries conflict, the most recent entry reflects the latest known state.`;
var OM_FOOTER_FULL = `----
${OM_INSTRUCTIONS_FULL}
----`;
var OM_FOOTER_BASIC = `----
${OM_INSTRUCTIONS_BASIC}
----`;
function observationToSummaryLine(observation) {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}
function scoreObservation(obs, index, total) {
  const base = obs.relevance === "high" || obs.relevance === "critical" ? 10 : obs.relevance === "medium" ? 5 : 1;
  const recency = total > 1 ? index / (total - 1) : 1;
  return base + recency;
}
function selectPriorObservations(observations, maxTokens) {
  const ranked = observations.map((obs, index) => ({
    obs,
    index,
    score: scoreObservation(obs, index, observations.length)
  }));
  ranked.sort((a, b) => b.score - a.score);
  const selected = [];
  let rendered = "";
  for (const item of ranked) {
    const next = rendered + (selected.length ? "\n" : "") + observationToSummaryLine(item.obs);
    if (estimateStringTokens(next) > maxTokens) continue;
    selected.push(item);
    rendered = next;
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.obs);
}
function reflectionToSummaryLine(reflection) {
  return `[${reflection.id}] ${reflection.content}`;
}
function selectPriorReflections(reflections, maxTokens) {
  const selected = [];
  let rendered = "";
  for (let i = reflections.length - 1; i >= 0; i--) {
    const reflection = reflections[i];
    const next = rendered + (selected.length ? "\n" : "") + reflectionToSummaryLine(reflection);
    if (estimateStringTokens(next) > maxTokens) continue;
    selected.push(reflection);
    rendered = next;
  }
  return selected.reverse();
}

// modules/blackhole/src/core/native-compaction-input.ts
function nativeContextEntries(branch) {
  let index = -1;
  for (let i = 0; i < branch.length; i++) if (branch[i].type === "compaction") index = i;
  if (index < 0) return [...branch];
  const checkpoint = branch[index];
  const start = checkpoint.firstKeptEntryId ? branch.findIndex((e) => e.id === checkpoint.firstKeptEntryId) : -1;
  return [checkpoint, ...start >= 0 && start < index ? branch.slice(start, index).filter((e) => !(e.type === "message" && e.message.role === "system")) : [], ...branch.slice(index + 1)];
}
function nativeEligibleEdits(branch) {
  const edits = /* @__PURE__ */ new Map();
  for (const entry of nativeContextEntries(branch)) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  return edits;
}

// modules/blackhole/src/core/generated-summary-spans.ts
import { createHash } from "node:crypto";
var GENERATED_SPANS_KEY = "blackhole.generatedSpans";
var digest = (text) => createHash("sha256").update(text).digest("hex");
function generatedSummaryProof(text, spans) {
  return { version: 1, sourceGeneration: digest(text), spans };
}
function validGeneratedProof(text, proof) {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof) || proof.version !== 1 || typeof proof.sourceGeneration !== "string" || !/^[a-f0-9]{64}$/.test(proof.sourceGeneration) || proof.sourceGeneration !== digest(text) || !Array.isArray(proof.spans) || proof.spans.length > 8) return false;
  for (const span of proof.spans) {
    if (typeof span !== "object" || span === null || Array.isArray(span) || !["recall", "om", "evidence"].includes(span.kind) || !Number.isSafeInteger(span.offset) || !Number.isSafeInteger(span.length) || span.offset < 0 || span.length < 1 || !Number.isSafeInteger(span.offset + span.length) || span.offset + span.length > text.length || typeof span.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(span.sha256) || digest(text.slice(span.offset, span.offset + span.length)) !== span.sha256) return false;
  }
  let end = 0;
  for (const span of [...proof.spans].sort((a, b) => a.offset - b.offset)) {
    if (span.offset < end) return false;
    end = span.offset + span.length;
  }
  return true;
}
function ownedSummaryProof(text, entries) {
  if (text === void 0) return;
  const latest = [...entries].reverse().find((e) => e.type === "compaction");
  if (latest?.details?.compactor !== "blackhole") return;
  const metadata = latest.details[GENERATED_SPANS_KEY];
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || metadata.version !== 1) return;
  const proof = text === latest.summary ? metadata?.summary : text === latest.details.trailingSummary ? metadata?.trailing : void 0;
  return validGeneratedProof(text, proof) ? proof : void 0;
}

// modules/blackhole/src/om/ledger/projection.ts
var OM_INVALIDATION_MARKER = "blackhole-om-source-invalidation";
function entryIndexById2(entries) {
  const indexes = /* @__PURE__ */ new Map();
  for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);
  return indexes;
}
function entryBoundary(entryId) {
  return { kind: "entry", entryId };
}
function tipBoundary() {
  return { kind: "tip" };
}
function boundaryIndex(entries, indexes, boundary) {
  if (boundary.kind === "tip") return entries.length - 1;
  if (boundary.kind === "none") return -1;
  return indexes.get(boundary.entryId) ?? -1;
}
function coverageIndex(entry, indexes) {
  return indexes.get(entry.data.coversUpToId) ?? -1;
}
function isAtOrBefore(index, boundaryIndex2) {
  return index >= 0 && boundaryIndex2 >= 0 && index <= boundaryIndex2;
}
function isCoveredAtOrBefore(entry, indexes, boundaryIndex2) {
  return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex2);
}
function memoryInvalidatedSources(entries) {
  const sources = new Set(nativeEligibleEdits(entries).keys());
  const latest = [...entries].reverse().find((e) => e.type === "compaction");
  if (latest && typeof latest.summary === "string") {
    if (ownedSummaryProof(latest.summary, entries)) for (const id of unwrapMemoryDetails(latest)?.invalidatedSourceEntryIds ?? []) sources.add(id);
    const generation = generatedSummaryProof(latest.summary, []).sourceGeneration;
    for (const entry of entries) {
      const data = entry.data;
      if (entry.type === "custom" && entry.customType === OM_INVALIDATION_MARKER && data?.version === 1 && data.compactionEntryId === latest.id && data.sourceGeneration === generation && Array.isArray(data.sourceEntryIds) && data.sourceEntryIds.every((id) => typeof id === "string" && id.length > 0)) for (const id of data.sourceEntryIds) sources.add(id);
    }
  }
  return sources;
}
function invalidObservationIds(entries) {
  const edits = memoryInvalidatedSources(entries);
  const invalid = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const observations = isObservationsRecordedEntry(entry) ? entry.data.observations : unwrapMemoryDetails(entry)?.observations ?? [];
    for (const observation of observations) if (observation.sourceEntryIds.some((id) => edits.has(id))) invalid.add(observation.id);
  }
  return invalid;
}
function foldProjection(entries, options) {
  const invalid = invalidObservationIds(entries);
  const indexes = entryIndexById2(entries);
  const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
  const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
  const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
  const observations = [];
  const reflections = [];
  const observationsById = /* @__PURE__ */ new Set();
  const reflectionsById = /* @__PURE__ */ new Set();
  const droppedObservationIds = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (isObservationsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, observationsBoundary)) {
      for (const observation of entry.data.observations) {
        if (invalid.has(observation.id) || observationsById.has(observation.id)) continue;
        observationsById.add(observation.id);
        observations.push(observation);
      }
      continue;
    }
    if (isReflectionsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)) {
      for (const reflection of entry.data.reflections) {
        if (reflection.supportingObservationIds.some((id) => invalid.has(id)) || reflectionsById.has(reflection.id)) continue;
        reflectionsById.add(reflection.id);
        reflections.push(reflection);
      }
      continue;
    }
    if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
      for (const observationId of entry.data.observationIds)
        droppedObservationIds.add(observationId);
    }
  }
  return {
    observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
    reflections
  };
}
function fullProjection(entries, upToEntryId) {
  const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
  return foldProjection(entries, {
    observationsBoundary: boundary,
    reflectionsBoundary: boundary,
    dropsBoundary: boundary
  });
}
function unwrapMemoryDetails(entry) {
  if (isMemoryDetails(entry.details)) return entry.details;
  if (entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)) {
    const nested = entry.details["om.folded"];
    if (isMemoryDetails(nested)) return nested;
  }
  return void 0;
}

// modules/blackhole/src/om/consolidation.ts
function oversizedIdentityForSkip(resolved) {
  if (resolved.source === "candidate") return resolved.candidateConfig;
  const model = resolved.model;
  return typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : void 0;
}
var MAX_STAGE_ATTEMPTS = 10;
var OBSERVER_DRAIN_MAX_BATCHES = 3;
var WORKER_SHRINK_MAX_BATCHES = 8;
var MAX_SIZE_SKIP_CONTINUATIONS = 10;
function sourceEntriesAfter(entries, index) {
  return entries.slice(index + 1).filter(isSourceEntry);
}
function capSourceEntriesToTokens(entries, maxTokens) {
  let totalTokens = 0;
  const kept = [];
  for (const entry of entries) {
    const estTokens = estimateEntryTokens(entry);
    if (totalTokens + estTokens > maxTokens) {
      if (kept.length > 0) break;
      kept.push(entry);
      break;
    }
    kept.push(entry);
    totalTokens += estTokens;
  }
  return kept;
}
function trimSerializedPrefix(entries, maxTokens) {
  if (entries.length === 0) return entries;
  const fits = (count) => estimateStringTokens(serializeSourceAddressedBranchEntries(entries.slice(0, count)).text) <= maxTokens;
  if (fits(entries.length)) return entries;
  let lo = 1;
  let hi = entries.length;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return entries.slice(0, lo);
}
function branchStillOwned(generation, ctx) {
  const leafId = generation.branchLeafId;
  if (leafId === void 0 || leafId === null) return true;
  try {
    const branch = ctx.sessionManager.getBranch();
    return Array.isArray(branch) && branch.some((entry) => entry?.id === leafId);
  } catch {
    return false;
  }
}
function appendEntry(pi, runtime, generation, customType, data, ctx) {
  if (!runtime.isGenerationActive(generation)) return false;
  if (!branchStillOwned(generation, ctx)) return false;
  pi.appendEntry(customType, data);
  return true;
}
function mergeReflections(existing, additional) {
  const seen = new Set(existing.map((reflection) => reflection.id));
  const merged = [...existing];
  for (const reflection of additional) {
    if (seen.has(reflection.id)) continue;
    seen.add(reflection.id);
    merged.push(reflection);
  }
  return merged;
}
function pendingObservationsCreatedAfter(pending, entries, afterCoversUpToId) {
  const batches = pending.observationBatches ?? [];
  if (!afterCoversUpToId || entryIndexForId(entries, afterCoversUpToId) < 0) {
    return batches.flatMap((b) => b.data?.observations ?? []);
  }
  const afterIdx = entryIndexForId(entries, afterCoversUpToId);
  const newObs = [];
  for (const batch2 of batches) {
    const batchIdx = entryIndexForId(entries, batch2.coversUpToId);
    if (batchIdx >= 0 && batchIdx > afterIdx) {
      newObs.push(...batch2.data?.observations ?? []);
    }
  }
  return newObs;
}
function dropperPressureReached(config2, poolTokens) {
  const poolMax = config2.observationsPoolMaxTokens;
  if (poolMax <= 0 || config2.dropperPressureThreshold >= 1) return false;
  return poolTokens / poolMax >= (config2.dropperPoolFullnessThreshold ?? 0.1) && poolTokens >= config2.dropperPressureThreshold * poolMax;
}
function activePoolSignature(entries, pending) {
  const observationIds = livePoolObservations(entries, pending).map((observation) => observation.id).sort();
  return JSON.stringify(observationIds);
}
function matchesEmptyPressurePool(runtime, poolSignature) {
  const cursor = runtime.cursors?.dropper;
  return cursor?.state === "empty" && cursor.activePoolSignature === poolSignature;
}
function anyStageDue(entries, runtime, pending) {
  const config2 = runtime.config;
  const cursors = runtime.cursors ?? {};
  const observerDue = (() => {
    const cursor = cursors.observer;
    if (!cursor) {
      return rawTokensSinceObservationCoverage(entries) >= config2.observeAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    const tokensSince = idx >= 0 ? rawTokensAfterIndex(entries, idx) : rawTokensSinceObservationCoverage(entries);
    return tokensSince >= config2.observeAfterTokens;
  })();
  const reflectorDue = (() => {
    const cursor = cursors.reflector;
    if (!cursor) {
      return rawTokensSinceReflectionCoverage(entries) >= config2.reflectAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx < 0) {
      return rawTokensSinceReflectionCoverage(entries) >= config2.reflectAfterTokens;
    }
    const tokensSince = rawTokensAfterIndex(entries, idx);
    if (tokensSince < config2.reflectAfterTokens) {
      return false;
    }
    for (let i = idx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === OM_OBSERVATIONS_RECORDED) {
        const markerCoversUpTo = e.data?.coversUpToId;
        if (markerCoversUpTo) {
          const markerCoversIdx = entryIndexForId(entries, markerCoversUpTo);
          if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
        }
        return true;
      }
    }
    if (pending) {
      const pendingBatches = pending.observationBatches ?? [];
      for (const batch2 of pendingBatches) {
        if (batch2.coversUpToId) {
          const batchIdx = entryIndexForId(entries, batch2.coversUpToId);
          if (batchIdx >= 0 && batchIdx > idx) return true;
        }
      }
    }
    return false;
  })();
  const dropperDue = observerDue || reflectorDue ? false : (() => {
    const poolTokens = observationPoolTokens(entries, pending).tokens;
    const fullnessVsPool = config2.observationsPoolMaxTokens > 0 ? poolTokens / config2.observationsPoolMaxTokens : 0;
    if (fullnessVsPool < (config2.dropperPoolFullnessThreshold ?? 0.1)) return false;
    if (dropperPressureReached(config2, poolTokens) && !matchesEmptyPressurePool(runtime, activePoolSignature(entries, pending)))
      return true;
    const cursor = cursors.dropper;
    if (!cursor) {
      const hasPendingNewData = pending ? (pending.observationBatches?.length ?? 0) > 0 || (pending.reflectionBatches?.length ?? 0) > 0 : false;
      if (hasPendingNewData) return true;
      return rawTokensSinceDropCoverage(entries) >= config2.reflectAfterTokens;
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx < 0) {
      return rawTokensSinceDropCoverage(entries) >= config2.reflectAfterTokens;
    }
    const tokensSince = rawTokensAfterIndex(entries, idx);
    if (tokensSince < config2.reflectAfterTokens) {
      return false;
    }
    for (let i = idx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "custom" && (e.customType === OM_OBSERVATIONS_RECORDED || e.customType === OM_REFLECTIONS_RECORDED)) {
        const markerCoversUpTo = e.data?.coversUpToId;
        if (markerCoversUpTo) {
          const markerCoversIdx = entryIndexForId(entries, markerCoversUpTo);
          if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
        }
        return true;
      }
    }
    if (pending) {
      const pendingObs = pending.observationBatches ?? [];
      const pendingRef = pending.reflectionBatches ?? [];
      for (const batch2 of [...pendingObs, ...pendingRef]) {
        if (batch2.coversUpToId) {
          const batchIdx = entryIndexForId(entries, batch2.coversUpToId);
          if (batchIdx >= 0 && batchIdx > idx) return true;
        }
      }
    }
    return false;
  })();
  return observerDue || reflectorDue || dropperDue;
}
function stageModelConfig(runtime, stage) {
  if (stage === "observer") return runtime.config.observerModel;
  if (stage === "reflector") return runtime.config.reflectorModel;
  return runtime.config.dropperModel;
}
function stageFallbackModels(runtime, stage) {
  if (stage === "observer") return runtime.config.observerFallbackModels ?? [];
  if (stage === "reflector") return runtime.config.reflectorFallbackModels ?? [];
  return runtime.config.dropperFallbackModels ?? [];
}
function stageThinkingLevel(runtime, stage, modelConfig) {
  const stageModel = modelConfig ?? stageModelConfig(runtime, stage);
  return stageModel?.thinking ?? runtime.config.model?.thinking ?? "low";
}
function makeModelResolver(runtime, ctx, generation) {
  return async (stage) => {
    const stageFallbacks = stageFallbackModels(runtime, stage);
    const resolved = await runtime.resolveModel(
      {
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        hasUI: ctx.hasUI,
        ui: ctx.ui,
        stageModel: stageModelConfig(runtime, stage),
        stageFallbacks
      },
      generation.signal
    );
    if (!runtime.isGenerationActive(generation)) return void 0;
    if (resolved.ok) {
      runtime.resolveFailureNotified = false;
      return resolved;
    }
    debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
    if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
      if (runtime.failedInCycle.size > 0 && resolved.reason.includes("all candidates exhausted") && !resolved.reason.includes("too small")) {
        const fallbackMsg = stageFallbacks.length === 0 ? "no fallbacks configured" : "no available fallbacks";
        runtime.tryEmitInfo(
          true,
          ctx.ui,
          `Observational memory: ${stage} skipped \u2014 model unavailable (cooldown set to 0, ${fallbackMsg}, will retry next run)`
        );
      } else {
        ctx.ui.notify(`Observational memory: ${stage} skipped \u2014 ${resolved.reason}`, "warning");
      }
      runtime.resolveFailureNotified = true;
    }
    return void 0;
  };
}
async function runConsolidationPipeline(pi, runtime, ctx, generation) {
  if (!runtime.isGenerationActive(generation)) return;
  const resolveModel = makeModelResolver(runtime, ctx, generation);
  runtime.consolidationPhase = "observer";
  runtime.failedInCycle.clear();
  runtime.sizeSkippedInCycle.clear();
  runtime.resolveFailureNotified = false;
  try {
    const observerOutcome = await runObserverStage(pi, runtime, ctx, generation, resolveModel);
    if (!runtime.isGenerationActive(generation) || observerOutcome === "abort") return;
  } catch (error) {
    if (!runtime.isGenerationActive(generation)) return;
    debugLog("observer.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error)
    });
    return;
  }
  runtime.consolidationPhase = "reflector";
  runtime.failedInCycle.clear();
  runtime.sizeSkippedInCycle.clear();
  runtime.resolveFailureNotified = false;
  let reflectorResult;
  try {
    reflectorResult = await runReflectorStage(pi, runtime, ctx, generation, resolveModel);
    if (!runtime.isGenerationActive(generation) || reflectorResult.outcome === "abort") return;
  } catch (error) {
    if (!runtime.isGenerationActive(generation)) return;
    debugLog("reflector.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error)
    });
    return;
  }
  runtime.consolidationPhase = "dropper";
  runtime.failedInCycle.clear();
  runtime.sizeSkippedInCycle.clear();
  runtime.resolveFailureNotified = false;
  try {
    await runDropperStage(
      pi,
      runtime,
      ctx,
      generation,
      resolveModel,
      reflectorResult.sameRunReflections,
      reflectorResult.effectiveReflectionCoverageId
    );
  } catch (error) {
    if (!runtime.isGenerationActive(generation)) return;
    debugLog("dropper.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error)
    });
  }
  let sessionId;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("pipeline.stale_ctx", { error: String(error) });
      return;
    }
    throw error;
  }
  runtime.scheduleCursorFlush(sessionId);
  const c = runtime.cursors ?? {};
  debugLog("cursor.saved", {
    observer: c.observer ?? null,
    reflector: c.reflector ?? null,
    dropper: c.dropper ?? null
  });
}
function handleWorkerErrorAfterClose(args) {
  const {
    runtime,
    ctx,
    stage,
    worker,
    keptNoun,
    errorText,
    resolved,
    stageModelForThinking,
    coverageId
  } = args;
  const afterClose = new Error(workerStreamErrorMessage(worker, errorText));
  const deterministic = isDeterministicError(afterClose);
  const sessionIdentity = resolved.model;
  const cooled = deterministic && (stageModelForThinking ? stageModelForThinking.cooldownHours !== 0 : typeof sessionIdentity?.provider === "string" && typeof sessionIdentity?.id === "string");
  if (stage === "observer") {
    debugLog("observer.error_after_close", {
      error: errorText,
      deterministic,
      coversUpToId: coverageId
    });
  } else {
    debugLog("reflector.error_after_close", {
      error: errorText,
      deterministic,
      observationCoverageId: coverageId
    });
  }
  if (deterministic) {
    runtime.recordRetryableError(stageModelForThinking, afterClose, stage);
    if (!stageModelForThinking) {
      runtime.recordDeterministicError(resolved.model, afterClose, stage);
    }
  }
  if (ctx.hasUI) {
    ctx.ui?.notify(
      `Observational memory: ${stage} kept its ${keptNoun}, but a later turn failed (${deterministic ? cooled ? "deterministic error, model cooled down; details in cooldown log" : "deterministic error; no cooldown recorded" : runtime.config.debugLog === true ? "transient error; details in debug log" : "transient error; enable debugLog for details"})`,
      "warning"
    );
  }
}
async function runObserverStage(pi, runtime, ctx, generation, resolveModel, drain = false, drainRemaining = OBSERVER_DRAIN_MAX_BATCHES) {
  if (!runtime.isGenerationActive(generation)) return "abort";
  let entries;
  let sessionId;
  try {
    entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("observer.stale_ctx", { error: String(error) });
      return "abort";
    }
    throw error;
  }
  const observerCursor = runtime.getCursor("observer");
  const observerFallbackStart = () => {
    const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
    return lastCoverageIdx >= 0 ? lastCoverageIdx : findLastCompactionIndex(entries);
  };
  let effectiveStart;
  if (observerCursor) {
    const cursorIdx = entryIndexForId(entries, observerCursor.entryId);
    effectiveStart = cursorIdx >= 0 ? cursorIdx : observerFallbackStart();
  } else {
    effectiveStart = observerFallbackStart();
  }
  const tokens = rawTokensAfterIndex(entries, effectiveStart);
  if (tokens < runtime.config.observeAfterTokens && !drain) {
    const anchorId = effectiveStart >= 0 ? entries[effectiveStart]?.id : void 0;
    if (anchorId) runtime.advanceCursor("observer", anchorId, "not_due");
    return "continue";
  }
  const allChunkEntries = sourceEntriesAfter(entries, effectiveStart);
  let chunkEntries = allChunkEntries;
  const maxChunkTokens = runtime.config.observerChunkMaxTokens;
  if (tokens > maxChunkTokens) {
    chunkEntries = capSourceEntriesToTokens(chunkEntries, maxChunkTokens);
  }
  let {
    text: chunk,
    sourceEntryIds,
    sourceEntryTimestamps
  } = serializeSourceAddressedBranchEntries(chunkEntries);
  let coversUpToId = sourceEntryIds.at(-1);
  if (!coversUpToId || !chunk.trim()) return "continue";
  const lastSourceEntryId = entries.filter(isSourceEntry).at(-1)?.id;
  const continueSources = () => {
    if (drainRemaining <= 0) return "continue";
    if (!coversUpToId || coversUpToId === lastSourceEntryId) return "continue";
    return runObserverStage(pi, runtime, ctx, generation, resolveModel, true, drainRemaining - 1);
  };
  let chunkTokens = estimateStringTokens(chunk);
  let capTokens = chunkEntries.reduce((s, e) => s + estimateEntryTokens(e), 0);
  const memory = fullProjection(entries);
  const preambleMaxTokens = runtime.config.observerPreambleMaxTokens > 0 ? runtime.config.observerPreambleMaxTokens : Math.round(runtime.config.observerChunkMaxTokens * 0.3);
  let priorReflections = selectPriorReflections(memory.reflections, preambleMaxTokens).map(
    reflectionToSummaryLine
  );
  let priorObservations = selectPriorObservations(memory.observations, preambleMaxTokens).map(
    observationToSummaryLine
  );
  if (isManualMode(runtime.config)) {
    const pendingCtx = readPendingState(sessionId);
    const accumulatedReflections = (pendingCtx.reflectionBatches ?? []).flatMap(
      (b) => b.data.reflections ?? []
    );
    const accumulatedObservations = (pendingCtx.observationBatches ?? []).flatMap(
      (b) => b.data.observations ?? []
    );
    const allObservations = [...memory.observations, ...accumulatedObservations];
    priorObservations = selectPriorObservations(allObservations, preambleMaxTokens).map(
      observationToSummaryLine
    );
    const allReflections = [...memory.reflections, ...accumulatedReflections];
    priorReflections = selectPriorReflections(allReflections, preambleMaxTokens).map(
      reflectionToSummaryLine
    );
  }
  const preambleTokens = estimateStringTokens(
    [...priorReflections, ...priorObservations].join("\n")
  );
  const observerSystemTokens = estimateStringTokens(OBSERVER_SYSTEM);
  const observerStaticTokens = workerStaticPromptTokens("observer");
  if (isManualMode(runtime.config) && isObservationChunkPending(sessionId, coversUpToId)) {
    debugLog("observer.pending_skip", { coversUpToId, sessionId });
    return "continue";
  }
  let bestFit;
  let sawAttemptError = false;
  let didShrink = false;
  let needsOutputShrink = false;
  if (drain) runtime.sizeSkippedInCycle.clear();
  const tryShrinkToFit = () => {
    if (!bestFit) return "abort";
    const bestModel = bestFit.resolved.model;
    const shrinkBudget = workerInputBudget(bestFit.ctx, bestModel) - observerStaticTokens - preambleTokens - WORKER_TURN_HEADROOM_TOKENS;
    if (shrinkBudget <= 0) return "abort";
    let baseEntries = allChunkEntries;
    if (needsOutputShrink) {
      needsOutputShrink = false;
      if (chunkEntries.length <= 1) {
        debugLog("observer.shrink_single_output_cut", {
          shrinkBudget,
          chunkTokens,
          coversUpToId,
          model: `${bestModel.provider}/${bestModel.id}`
        });
        return "abort";
      }
      baseEntries = chunkEntries.slice(0, Math.max(1, Math.floor(chunkEntries.length / 2)));
    }
    const shrunkEntries = trimSerializedPrefix(
      capSourceEntriesToTokens(baseEntries, shrinkBudget),
      shrinkBudget
    );
    const shrunk = serializeSourceAddressedBranchEntries(shrunkEntries);
    if (shrunkEntries.length === 1 && estimateStringTokens(shrunk.text) > shrinkBudget) {
      debugLog("observer.shrink_single_oversized", {
        shrinkBudget,
        chunkTokens: estimateStringTokens(shrunk.text),
        coversUpToId: shrunk.sourceEntryIds.at(-1),
        model: `${bestModel.provider}/${bestModel.id}`
      });
    }
    const shrunkCover = shrunk.sourceEntryIds.at(-1);
    if (!shrunkCover || !shrunk.text.trim()) return "abort";
    chunkEntries = shrunkEntries;
    chunk = shrunk.text;
    sourceEntryIds = shrunk.sourceEntryIds;
    sourceEntryTimestamps = shrunk.sourceEntryTimestamps;
    coversUpToId = shrunkCover;
    chunkTokens = estimateStringTokens(chunk);
    capTokens = chunkEntries.reduce((s, e) => s + estimateEntryTokens(e), 0);
    didShrink = true;
    if (isManualMode(runtime.config) && isObservationChunkPending(sessionId, coversUpToId)) {
      debugLog("observer.pending_skip", { coversUpToId, sessionId });
      return "continue";
    }
    runtime.unskipOversizedForCycle(oversizedIdentityForSkip(bestFit.resolved));
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: observer shrinking chunk to fit ${bestModel.provider}/${bestModel.id} (~${shrinkBudget.toLocaleString()}-token budget)`
    );
    debugLog("observer.shrink_to_fit", {
      shrinkBudget,
      chunkTokens,
      coversUpToId,
      model: `${bestModel.provider}/${bestModel.id}`
    });
    return "shrunk";
  };
  let attempt = 0;
  let sizeSkips = 0;
  while (attempt < MAX_STAGE_ATTEMPTS) {
    const resolved = await resolveModel("observer");
    if (!runtime.isGenerationActive(generation)) return "abort";
    if (!resolved) {
      if ((!didShrink || needsOutputShrink) && bestFit && !sawAttemptError) {
        const shrunk = tryShrinkToFit();
        if (shrunk === "shrunk") continue;
        return shrunk;
      }
      return "abort";
    }
    let effectiveTokens = tokens;
    if (isManualMode(runtime.config)) {
      const pending = readPendingState(sessionId);
      if (pending.observation?.coversUpToId) {
        const idx = entryIndexForId(entries, pending.observation.coversUpToId);
        if (idx >= 0) effectiveTokens = rawTokensAfterIndex(entries, idx);
      }
    }
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk (of ${effectiveTokens.toLocaleString()} accumulated)`
    );
    debugLog("observer.start", {
      tokens,
      maxChunkTokens,
      chunkTokens,
      capTokens,
      preambleTokens,
      coversUpToId,
      sourceEntryIds,
      sourceEntryCount: sourceEntryIds.length,
      priorReflections: priorReflections.length,
      priorObservations: priorObservations.length
    });
    const stageModelForThinking = resolved.source === "candidate" ? resolved.candidateConfig : void 0;
    const effectiveObsCtx = effectiveContextWindow(resolved.model, stageModelForThinking);
    if (!bestFit || effectiveObsCtx > bestFit.ctx) bestFit = { resolved, ctx: effectiveObsCtx };
    const observerEstimatedInput = chunkTokens + preambleTokens + observerStaticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const observerInputBudget = workerInputBudget(effectiveObsCtx, resolved.model);
    if (observerEstimatedInput > observerInputBudget) {
      debugLog("observer.context_window_exceeded", {
        estimatedInput: observerEstimatedInput,
        inputBudget: observerInputBudget,
        chunkTokens,
        preambleTokens,
        systemTokens: observerSystemTokens,
        staticTokens: observerStaticTokens,
        effectiveCtx: effectiveObsCtx,
        model: `${resolved.model.provider}/${resolved.model.id}`
      });
      runtime.skipOversizedForCycle(oversizedIdentityForSkip(resolved));
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: observer skipping ${resolved.model.provider}/${resolved.model.id} (context window ${effectiveObsCtx.toLocaleString()} too small for ~${observerEstimatedInput.toLocaleString()}-token input)`
      );
      sizeSkips += 1;
      if (sizeSkips > MAX_SIZE_SKIP_CONTINUATIONS) {
        if ((!didShrink || needsOutputShrink) && bestFit && !sawAttemptError) {
          const shrunk = tryShrinkToFit();
          if (shrunk === "shrunk") continue;
          return shrunk;
        }
        return "abort";
      }
      continue;
    }
    try {
      attempt += 1;
      const { runObserver: runObserver2 } = await Promise.resolve().then(() => (init_offline_observer(), offline_observer_exports));
      const result = await runWorkerAttempt(
        "observer",
        runtime.config.workerAttemptTimeoutMs,
        generation.signal,
        (signal) => runObserver2({
          model: resolved.model,
          apiKey: resolved.apiKey,
          headers: withProviderAttributionHeaders(
            resolved.model,
            resolved.headers,
            sessionId
          ),
          env: resolved.env,
          maxOutputTokens: workerOutputAllowance(effectiveObsCtx, resolved.model),
          priorReflections,
          priorObservations,
          chunk,
          allowedSourceEntryIds: sourceEntryIds,
          sourceEntryTimestamps,
          maxTurns: runtime.config.agentMaxTurns,
          thinkingLevel: stageThinkingLevel(runtime, "observer", stageModelForThinking),
          providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
          signal,
          modelRegistry: ctx.modelRegistry,
          sessionId,
          cacheRetention: runtime.config.cacheRetention
        })
      );
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (result.errorAfterClose) {
        handleWorkerErrorAfterClose({
          runtime,
          ctx,
          stage: "observer",
          worker: "Observer",
          keptNoun: "completed chunk",
          errorText: result.errorAfterClose,
          resolved,
          stageModelForThinking,
          coverageId: coversUpToId
        });
      }
      if (result.observations && result.observations.length > 0) {
        const data = buildObservationsRecordedData(result.observations, coversUpToId);
        if (!data) {
          runtime.advanceCursor("observer", coversUpToId, "empty");
          return "continue";
        }
        debugLog("observer.records", {
          count: result.observations.length,
          observationTokens: result.observations.reduce((s, o) => s + o.tokenCount, 0),
          coversUpToId
        });
        if (isManualMode(runtime.config)) {
          if (!runtime.isGenerationActive(generation) || !branchStillOwned(generation, ctx)) return "abort";
          savePendingObservation(sessionId, { coversUpToId, data });
          debugLog("observer.pending", {
            count: result.observations.length,
            coversUpToId,
            sessionId
          });
        } else {
          if (!appendEntry(pi, runtime, generation, OM_OBSERVATIONS_RECORDED, data, ctx)) return "abort";
          debugLog("observer.appended", {
            count: result.observations.length,
            coversUpToId
          });
        }
        runtime.advanceCursor("observer", coversUpToId, "recorded");
        runtime.tryEmitWorkerInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: ${result.observations.length} observation${result.observations.length === 1 ? "" : "s"} recorded`
        );
        return continueSources();
      }
      const reason = result.emptyReason;
      const reasonLabel = reason ? reason.kind === "tool_not_called" ? "model did not call the observation tool" : reason.kind === "all_rejected" ? `${reason.count} observation(s) rejected for invalid sourceEntryIds` : reason.kind === "all_duplicates" ? `${reason.count} observation(s) were duplicates of already-recorded entries` : reason.kind === "empty_array" ? "model called the tool but submitted an empty observations array" : "nothing new to record" : "unknown reason";
      const reasonLevel = reason ? reason.kind === "no_new_content" || reason.kind === "all_duplicates" ? "info" : "warning" : "warning";
      debugLog("observer.empty", { coversUpToId, reason: reason?.kind });
      runtime.advanceCursor("observer", coversUpToId, "empty");
      if (reasonLevel === "warning") {
        if (ctx.hasUI)
          ctx.ui?.notify(`Observational memory: no observations \u2014 ${reasonLabel}`, "warning");
      } else {
        runtime.tryEmitWorkerInfo(
          ctx.hasUI,
          ctx.ui,
          `Observational memory: no observations \u2014 ${reasonLabel}`
        );
      }
      return continueSources();
    } catch (error) {
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (isStaleExtensionContextError(error)) {
        debugLog("observer.stale_ctx", { error: String(error) });
        return "abort";
      }
      if (error instanceof WorkerStreamError && error.lengthCut && !error.turnCapExhausted) {
        const candidateConfig2 = stageModelForThinking;
        if (candidateConfig2) {
          const outputAllowance = workerOutputAllowance(effectiveObsCtx, resolved.model);
          debugLog("observer.output_allowance_exceeded", {
            outputAllowance,
            model: `${resolved.model.provider}/${resolved.model.id}`,
            discardedCount: getDiscardedCount(error)
          });
          runtime.skipOversizedForCycle(candidateConfig2);
          runtime.tryEmitInfo(
            ctx.hasUI,
            ctx.ui,
            `Observational memory: observer skipping ${resolved.model.provider}/${resolved.model.id} (output allowance ~${outputAllowance.toLocaleString()} tokens too small for this input)`
          );
          needsOutputShrink = true;
          continue;
        }
      }
      if (!(error instanceof WorkerStreamError && (error.turnCapExhausted || error.lengthCut)))
        sawAttemptError = true;
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "observer");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "observer");
      debugLog("observer.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        // Records written before a stream error and discarded with the run.
        discardedCount: getDiscardedCount(error)
      });
      if (!candidateConfig && (error instanceof WorkerAttemptTimeoutError || error instanceof WorkerStreamError && (error.turnCapExhausted || error.lengthCut)))
        break;
      continue;
    }
  }
  runtime.recordConsolidationStageError(
    ctx,
    "observer",
    new Error("Observer: all model candidates exhausted")
  );
  return "abort";
}
function planPrefixBatches(items, tokenOf, budget) {
  const batches = [];
  let batch2 = [];
  let used = 0;
  for (const item of items) {
    const tokens = tokenOf(item);
    if (batch2.length > 0 && used + tokens > budget) {
      batches.push(batch2);
      batch2 = [];
      used = 0;
    }
    batch2.push(item);
    used += tokens;
  }
  if (batch2.length > 0) batches.push(batch2);
  return batches;
}
function computeReflectorInput(runtime, entries, sessionId, reflectionTokens) {
  const folded = foldLedger(entries);
  const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : void 0;
  const lastReflectionIdx = pending ? -1 : latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
  const newObservations = pending ? pendingObservationsCreatedAfter(pending, entries, pending.reflection?.coversUpToId) : observationsCreatedAfterIndex(entries, lastReflectionIdx);
  const newReflections = pending ? [] : reflectionsCreatedAfterIndex(entries, lastReflectionIdx);
  const newItemsTokens = (
    // Rendered lines, not bare content: the agent sends
    // observationToSummaryLine / reflectionToSummaryLine per item, and the
    // fit-check must price what is dispatched (see planPrefixBatches).
    newObservations.reduce(
      (s, o) => s + estimateStringTokens(observationToSummaryLine(o)),
      0
    ) + newReflections.reduce(
      (s, r) => s + estimateStringTokens(reflectionToSummaryLine(r)),
      0
    )
  );
  const summaryBudget = Math.floor(runtime.config.reflectorInputMaxTokens * 0.15) * 2;
  const reflectorInputTokens = Math.min(
    newItemsTokens + summaryBudget,
    runtime.config.reflectorInputMaxTokens
  );
  let effectiveReflectionTokens = reflectionTokens;
  if (isManualMode(runtime.config)) {
    if (pending?.reflection?.coversUpToId) {
      const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
      if (idx >= 0) effectiveReflectionTokens = rawTokensAfterIndex(entries, idx);
    }
  }
  const sourceReflections = pending ? [
    ...folded.reflections,
    ...(pending.reflectionBatches ?? []).flatMap(
      (b) => b.data?.reflections ?? []
    )
  ] : folded.reflections;
  const sourceObservations = pending ? [
    ...folded.activeObservations,
    ...(pending.observationBatches ?? []).flatMap(
      (b) => b.data?.observations ?? []
    )
  ] : folded.activeObservations;
  const existingReflectionsSummary = buildExistingReflectionsSummary(
    sourceReflections,
    Math.floor(runtime.config.reflectorInputMaxTokens * 0.15)
  );
  const existingObservationsSummary = buildExistingObservationsSummary(
    sourceObservations.filter((o) => !newObservations.some((no) => no.id === o.id)),
    Math.floor(runtime.config.reflectorInputMaxTokens * 0.15)
  );
  const summaryTokens = estimateStringTokens(
    `${existingReflectionsSummary}
${existingObservationsSummary}`
  );
  return {
    folded,
    pending,
    newObservations,
    newReflections,
    newItemsTokens,
    reflectorInputTokens,
    effectiveReflectionTokens,
    existingReflectionsSummary,
    existingObservationsSummary,
    summaryTokens
  };
}
async function runReflectorStage(pi, runtime, ctx, generation, resolveModel) {
  if (!runtime.isGenerationActive(generation)) return { outcome: "abort", sameRunReflections: [] };
  let entries;
  let sessionId;
  try {
    entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("reflector.stale_ctx", { error: String(error) });
      return { outcome: "abort", sameRunReflections: [] };
    }
    throw error;
  }
  let reflectionTokens = 0;
  let observationCoverageId;
  if (isManualMode(runtime.config)) {
    const pending = readPendingState(sessionId);
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b) => b.data?.observations?.length
    );
    if (!hasPendingObs) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped");
      return { outcome: "continue", sameRunReflections: [] };
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.reflection?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const refIdx = entryIndexForId(entries, pending.reflection.coversUpToId);
      if (obsIdx >= 0 && refIdx >= 0 && obsIdx <= refIdx) {
        runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "skipped");
        return { outcome: "continue", sameRunReflections: [] };
      }
      if (refIdx >= 0) {
        reflectionTokens = rawTokensAfterIndex(entries, refIdx);
        if (reflectionTokens < runtime.config.reflectAfterTokens) {
          runtime.advanceCursor("reflector", pending.reflection.coversUpToId, "not_due");
          return { outcome: "continue", sameRunReflections: [] };
        }
      } else {
        reflectionTokens = rawTokensSinceObservationCoverage(entries);
      }
    } else {
      reflectionTokens = rawTokensSinceObservationCoverage(entries);
    }
  } else {
    reflectionTokens = rawTokensSinceReflectionCoverage(entries);
    if (reflectionTokens < runtime.config.reflectAfterTokens) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "not_due");
      return { outcome: "continue", sameRunReflections: [] };
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "skipped");
      return { outcome: "continue", sameRunReflections: [] };
    }
  }
  const input = computeReflectorInput(runtime, entries, sessionId, reflectionTokens);
  const reflectorStaticTokens = workerStaticPromptTokens("reflector");
  const commitReflectorResult = (reflections, errorText, resolved) => {
    if (errorText) {
      handleWorkerErrorAfterClose({
        runtime,
        ctx,
        stage: "reflector",
        worker: "Reflector",
        keptNoun: "completed review",
        errorText,
        resolved,
        stageModelForThinking: resolved.source === "candidate" ? resolved.candidateConfig : void 0,
        coverageId: observationCoverageId
      });
    }
    if (!reflections || reflections.length === 0) {
      runtime.advanceCursor(
        "reflector",
        observationCoverageId ?? entries.at(-1)?.id ?? "unknown",
        "empty"
      );
      return { outcome: "continue", sameRunReflections: [] };
    }
    if (!observationCoverageId) {
      runtime.advanceCursor("reflector", entries.at(-1)?.id ?? "unknown", "empty");
      return { outcome: "continue", sameRunReflections: [] };
    }
    const data = buildReflectionsRecordedData(reflections, observationCoverageId);
    if (!data) {
      runtime.advanceCursor("reflector", observationCoverageId, "empty");
      return { outcome: "continue", sameRunReflections: [] };
    }
    if (isManualMode(runtime.config)) {
      if (!runtime.isGenerationActive(generation) || !branchStillOwned(generation, ctx)) {
        return { outcome: "abort", sameRunReflections: [] };
      }
      savePendingReflection(sessionId, {
        coversUpToId: data.coversUpToId,
        data
      });
    } else {
      if (!appendEntry(pi, runtime, generation, OM_REFLECTIONS_RECORDED, data, ctx)) {
        return { outcome: "abort", sameRunReflections: [] };
      }
    }
    runtime.advanceCursor("reflector", data.coversUpToId, "recorded");
    return {
      outcome: "continue",
      sameRunReflections: reflections,
      effectiveReflectionCoverageId: data.coversUpToId
    };
  };
  const runShrunkBatches = async (best) => {
    const bestModel = best.resolved.model;
    const stageModelForBatch = best.resolved.source === "candidate" ? best.resolved.candidateConfig : void 0;
    const newReflectionsTokens = input.newReflections.reduce(
      (s, r) => s + estimateStringTokens(reflectionToSummaryLine(r)),
      0
    );
    const batchFixedOverhead = input.summaryTokens + newReflectionsTokens + reflectorStaticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const batchBudget = workerInputBudget(best.ctx, bestModel);
    const itemBudget = batchBudget - batchFixedOverhead;
    if (itemBudget <= 0) return { outcome: "abort", sameRunReflections: [] };
    const batches = planPrefixBatches(
      input.newObservations,
      (o) => estimateStringTokens(observationToSummaryLine(o)),
      itemBudget
    );
    if (input.newObservations.length > 0) {
      const oversized = batches.find(
        (batch2) => batch2.reduce((s, o) => s + estimateStringTokens(observationToSummaryLine(o)), 0) + batchFixedOverhead > batchBudget
      );
      if (oversized) return { outcome: "abort", sameRunReflections: [] };
    }
    const planned = batches.length > 0 ? batches : [[]];
    if (planned.length > WORKER_SHRINK_MAX_BATCHES) {
      debugLog("reflector.batch_cap", {
        batchCount: planned.length,
        maxBatches: WORKER_SHRINK_MAX_BATCHES,
        newObsCount: input.newObservations.length,
        model: `${bestModel.provider}/${bestModel.id}`
      });
      runtime.tryEmitWorkerInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: reflector deferring ${input.newObservations.length} observations (${planned.length} fit-to-window batches exceeds the per-run limit of ${WORKER_SHRINK_MAX_BATCHES}; a larger reflector model would clear the backlog)`
      );
      return { outcome: "abort", sameRunReflections: [] };
    }
    debugLog("reflector.batch_plan", {
      batchCount: planned.length,
      batchSizes: planned.map((b) => b.length),
      newObsCount: input.newObservations.length,
      model: `${bestModel.provider}/${bestModel.id}`
    });
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: reflector batching ${input.newObservations.length} observations into ${planned.length} fit-to-window batches on ${bestModel.provider}/${bestModel.id}`
    );
    let merged = [];
    let firstError;
    const queue = [...planned];
    const isSessionBest = best.resolved.source !== "candidate";
    let batchRuns = 0;
    const voidBatchedRun = (error) => {
      const candidateConfig = stageModelForBatch;
      runtime.recordRetryableError(candidateConfig, error, "reflector");
      if (!candidateConfig) runtime.recordDeterministicError(bestModel, error, "reflector");
      debugLog("reflector.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        discardedCount: getDiscardedCount(error)
      });
      runtime.recordConsolidationStageError(ctx, "reflector", error);
      return { outcome: "abort", sameRunReflections: [] };
    };
    while (queue.length > 0) {
      const batch2 = queue.shift();
      if (!batch2 || batch2.length === 0) continue;
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };
      batchRuns += 1;
      if (batchRuns > WORKER_SHRINK_MAX_BATCHES) {
        debugLog("reflector.batch_cap", {
          batchRuns,
          maxBatches: WORKER_SHRINK_MAX_BATCHES,
          newObsCount: input.newObservations.length,
          model: `${bestModel.provider}/${bestModel.id}`
        });
        return { outcome: "abort", sameRunReflections: [] };
      }
      debugLog("reflector.batch_start", {
        batchIndex: batchRuns,
        batchCount: planned.length,
        batchObsCount: batch2.length,
        model: `${bestModel.provider}/${bestModel.id}`
      });
      try {
        const { runReflector: runReflector2 } = await Promise.resolve().then(() => (init_offline_reflector(), offline_reflector_exports));
        const result = await runWorkerAttempt(
          "reflector",
          runtime.config.workerAttemptTimeoutMs,
          generation.signal,
          (signal) => runReflector2({
            model: bestModel,
            apiKey: best.resolved.apiKey,
            headers: withProviderAttributionHeaders(bestModel, best.resolved.headers, sessionId),
            env: best.resolved.env,
            maxOutputTokens: workerOutputAllowance(best.ctx, bestModel),
            reflections: input.newReflections,
            observations: batch2,
            existingReflectionsSummary: input.existingReflectionsSummary || void 0,
            existingObservationsSummary: input.existingObservationsSummary || void 0,
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForBatch),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
            cacheRetention: runtime.config.cacheRetention
          })
        );
        if (!runtime.isGenerationActive(generation))
          return { outcome: "abort", sameRunReflections: [] };
        if (result.errorAfterClose !== void 0 && firstError === void 0) {
          firstError = result.errorAfterClose;
        }
        merged = mergeReflections(merged, result.reflections ?? []);
      } catch (error) {
        if (!runtime.isGenerationActive(generation))
          return { outcome: "abort", sameRunReflections: [] };
        if (isStaleExtensionContextError(error)) {
          debugLog("reflector.stale_ctx", { error: String(error) });
          return { outcome: "abort", sameRunReflections: [] };
        }
        if (!isSessionBest && error instanceof WorkerStreamError && (error.lengthCut || error.turnCapExhausted) && batch2.length > 1) {
          const mid = Math.max(1, Math.floor(batch2.length / 2));
          queue.unshift(batch2.slice(0, mid), batch2.slice(mid));
          debugLog("reflector.batch_split", {
            batchObsCount: batch2.length,
            model: `${bestModel.provider}/${bestModel.id}`
          });
          continue;
        }
        return voidBatchedRun(error);
      }
    }
    return commitReflectorResult(merged.length > 0 ? merged : void 0, firstError, best.resolved);
  };
  let bestFit;
  let sawAttemptError = false;
  let attempt = 0;
  let sizeSkips = 0;
  while (attempt < MAX_STAGE_ATTEMPTS) {
    const resolved = await resolveModel("reflector");
    if (!runtime.isGenerationActive(generation))
      return { outcome: "abort", sameRunReflections: [] };
    if (!resolved) {
      if (bestFit && !sawAttemptError) return runShrunkBatches(bestFit);
      return { outcome: "abort", sameRunReflections: [] };
    }
    debugLog("reflector.start", {
      tokens: input.effectiveReflectionTokens,
      inputTokens: input.reflectorInputTokens,
      newObsCount: input.newObservations.length,
      newRefCount: input.newReflections.length
    });
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: reflector running (~${input.effectiveReflectionTokens.toLocaleString()} tokens accumulated, ~${input.reflectorInputTokens.toLocaleString()}-token input)`
    );
    const stageModelForThinking = resolved.source === "candidate" ? resolved.candidateConfig : void 0;
    const effectiveRefCtx = effectiveContextWindow(resolved.model, stageModelForThinking);
    if (!bestFit || effectiveRefCtx > bestFit.ctx) bestFit = { resolved, ctx: effectiveRefCtx };
    const reflectorEstimatedInput = input.newItemsTokens + input.summaryTokens + reflectorStaticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const reflectorInputBudget = workerInputBudget(effectiveRefCtx, resolved.model);
    if (reflectorEstimatedInput > reflectorInputBudget) {
      debugLog("reflector.context_window_exceeded", {
        estimatedInput: reflectorEstimatedInput,
        inputBudget: reflectorInputBudget,
        newItemsTokens: input.newItemsTokens,
        summaryTokens: input.summaryTokens,
        staticTokens: reflectorStaticTokens,
        effectiveCtx: effectiveRefCtx,
        model: `${resolved.model.provider}/${resolved.model.id}`
      });
      runtime.skipOversizedForCycle(oversizedIdentityForSkip(resolved));
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: reflector skipping ${resolved.model.provider}/${resolved.model.id} (context window ${effectiveRefCtx.toLocaleString()} too small for ~${reflectorEstimatedInput.toLocaleString()}-token input)`
      );
      sizeSkips += 1;
      if (sizeSkips > MAX_SIZE_SKIP_CONTINUATIONS) {
        if (bestFit && !sawAttemptError) return runShrunkBatches(bestFit);
        return { outcome: "abort", sameRunReflections: [] };
      }
      continue;
    }
    try {
      attempt += 1;
      const { runReflector: runReflector2 } = await Promise.resolve().then(() => (init_offline_reflector(), offline_reflector_exports));
      const result = await runWorkerAttempt(
        "reflector",
        runtime.config.workerAttemptTimeoutMs,
        generation.signal,
        (signal) => runReflector2({
          model: resolved.model,
          apiKey: resolved.apiKey,
          headers: withProviderAttributionHeaders(
            resolved.model,
            resolved.headers,
            sessionId
          ),
          env: resolved.env,
          maxOutputTokens: workerOutputAllowance(effectiveRefCtx, resolved.model),
          reflections: input.newReflections,
          observations: input.newObservations,
          existingReflectionsSummary: input.existingReflectionsSummary || void 0,
          existingObservationsSummary: input.existingObservationsSummary || void 0,
          maxTurns: runtime.config.agentMaxTurns,
          thinkingLevel: stageThinkingLevel(runtime, "reflector", stageModelForThinking),
          providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
          signal,
          modelRegistry: ctx.modelRegistry,
          sessionId,
          cacheRetention: runtime.config.cacheRetention
        })
      );
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };
      return commitReflectorResult(result.reflections, result.errorAfterClose, resolved);
    } catch (error) {
      if (!runtime.isGenerationActive(generation))
        return { outcome: "abort", sameRunReflections: [] };
      if (isStaleExtensionContextError(error)) {
        debugLog("reflector.stale_ctx", { error: String(error) });
        return { outcome: "abort", sameRunReflections: [] };
      }
      if (error instanceof WorkerStreamError && error.lengthCut && !error.turnCapExhausted) {
        const candidateConfig2 = stageModelForThinking;
        if (candidateConfig2) {
          const outputAllowance = workerOutputAllowance(effectiveRefCtx, resolved.model);
          debugLog("reflector.output_allowance_exceeded", {
            outputAllowance,
            model: `${resolved.model.provider}/${resolved.model.id}`,
            discardedCount: getDiscardedCount(error)
          });
          runtime.skipOversizedForCycle(candidateConfig2);
          runtime.tryEmitInfo(
            ctx.hasUI,
            ctx.ui,
            `Observational memory: reflector skipping ${resolved.model.provider}/${resolved.model.id} (output allowance ~${outputAllowance.toLocaleString()} tokens too small for this input)`
          );
          continue;
        }
      }
      if (!(error instanceof WorkerStreamError && (error.turnCapExhausted || error.lengthCut)))
        sawAttemptError = true;
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "reflector");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "reflector");
      debugLog("reflector.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        // Reflections recorded before the run failed and discarded with it.
        discardedCount: getDiscardedCount(error)
      });
      if (!candidateConfig && (error instanceof WorkerAttemptTimeoutError || error instanceof WorkerStreamError && (error.turnCapExhausted || error.lengthCut)))
        break;
      continue;
    }
  }
  runtime.recordConsolidationStageError(
    ctx,
    "reflector",
    new Error("Reflector: all model candidates exhausted")
  );
  return { outcome: "abort", sameRunReflections: [] };
}
function computeDropperInput(runtime, entries, sessionId, sameRunReflections, dropTokens, pressureRun, pendingOverride) {
  const folded = foldLedger(entries);
  const pending = pendingOverride ?? (isManualMode(runtime.config) ? readPendingState(sessionId) : void 0);
  const lastDropIdx = pending ? -1 : latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
  const newObservations = pressureRun ? livePoolObservations(entries, pending) : pending ? pendingObservationsCreatedAfter(pending, entries, pending.dropped?.coversUpToId) : observationsCreatedAfterIndex(entries, lastDropIdx);
  const pendingReflections = pending ? [
    ...folded.reflections,
    ...(pending.reflectionBatches ?? []).flatMap(
      (b) => b.data?.reflections ?? []
    )
  ] : folded.reflections;
  const reflectionsForDropper = mergeReflections(pendingReflections, sameRunReflections);
  const coverageById = reflectionCoverageMap(newObservations, reflectionsForDropper);
  const dropperNewObsTokens = newObservations.reduce(
    // Rendered dropper lines, not bare content: the agent sends
    // observationToDropperLine per candidate, and the fit-check must price
    // what is dispatched (see planPrefixBatches).
    (s, o) => s + estimateStringTokens(
      observationToDropperLine(o, coverageTierForObservation(o, coverageById))
    ),
    0
  );
  const dropperSummaryBudget = Math.floor(runtime.config.dropperInputMaxTokens * 0.2);
  const dropperInputTokens = dropperNewObsTokens + dropperSummaryBudget;
  let effectiveDropTokens = dropTokens;
  if (isManualMode(runtime.config)) {
    if (pending?.dropped?.coversUpToId) {
      const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
      if (idx >= 0) effectiveDropTokens = rawTokensAfterIndex(entries, idx);
    }
  }
  const sourceObsForDropper = pending ? [
    ...folded.activeObservations,
    ...(pending.observationBatches ?? []).flatMap(
      (b) => b.data?.observations ?? []
    )
  ] : folded.activeObservations;
  const existingObservationsSummary = buildExistingObservationsSummary(
    sourceObsForDropper.filter((o) => !newObservations.some((no) => no.id === o.id)),
    Math.floor(runtime.config.dropperInputMaxTokens * 0.2)
  );
  const summaryTokens = estimateStringTokens(existingObservationsSummary);
  return {
    folded,
    pending,
    newObservations,
    dropperNewObsTokens,
    dropperInputTokens,
    effectiveDropTokens,
    existingObservationsSummary,
    summaryTokens,
    reflectionsForDropper
  };
}
async function runDropperStage(pi, runtime, ctx, generation, resolveModel, sameRunReflections, sameRunReflectionCoverageId) {
  if (!runtime.isGenerationActive(generation)) return "abort";
  let entries;
  let sessionId;
  try {
    entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    if (isStaleExtensionContextError(error)) {
      debugLog("dropper.stale_ctx", { error: String(error) });
      return "abort";
    }
    throw error;
  }
  let dropTokens = 0;
  let observationCoverageId;
  const pressurePending = isManualMode(runtime.config) ? readPendingState(sessionId) : void 0;
  const pressurePoolSignature = activePoolSignature(entries, pressurePending);
  const pressureReached = dropperPressureReached(
    runtime.config,
    observationPoolTokens(entries, pressurePending).tokens
  );
  const pressureAlreadyChecked = pressureReached && matchesEmptyPressurePool(runtime, pressurePoolSignature);
  const pressureRun = pressureReached && !pressureAlreadyChecked;
  const advanceDropperCursor = (entryId, state) => {
    if (!pressureAlreadyChecked) runtime.advanceCursor("dropper", entryId, state);
  };
  if (isManualMode(runtime.config)) {
    const pending = pressurePending ?? readPendingState(sessionId);
    const hasPendingObs = (pending.observationBatches ?? []).some(
      (b) => b.data?.observations?.length
    );
    if (!hasPendingObs && !pressureRun) {
      advanceDropperCursor(entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
    observationCoverageId = pending.observation?.coversUpToId;
    if (pending.dropped?.coversUpToId) {
      const obsIdx = entryIndexForId(entries, pending.observation?.coversUpToId ?? "");
      const dropIdx = entryIndexForId(entries, pending.dropped.coversUpToId);
      if (obsIdx >= 0 && dropIdx >= 0 && obsIdx <= dropIdx && !pressureRun) {
        advanceDropperCursor(pending.dropped.coversUpToId, "skipped");
        return "continue";
      }
      if (dropIdx >= 0) {
        dropTokens = rawTokensAfterIndex(entries, dropIdx);
        if (dropTokens < runtime.config.reflectAfterTokens && !pressureRun) {
          advanceDropperCursor(pending.dropped.coversUpToId, "not_due");
          return "continue";
        }
      } else {
        dropTokens = rawTokensSinceDropCoverage(entries);
      }
    } else {
      dropTokens = rawTokensSinceDropCoverage(entries);
    }
  } else {
    dropTokens = rawTokensSinceDropCoverage(entries);
    if (dropTokens < runtime.config.reflectAfterTokens && !pressureRun) {
      advanceDropperCursor(entries.at(-1)?.id ?? "unknown", "not_due");
      return "continue";
    }
    observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
    if (!observationCoverageId && !pressureRun) {
      advanceDropperCursor(entries.at(-1)?.id ?? "unknown", "skipped");
      return "continue";
    }
  }
  if (!observationCoverageId) observationCoverageId = entries.at(-1)?.id ?? "unknown";
  const input = computeDropperInput(
    runtime,
    entries,
    sessionId,
    sameRunReflections,
    dropTokens,
    pressureRun,
    pressurePending
  );
  const dropperStaticTokens = workerStaticPromptTokens("dropper");
  const dropperReflectionsTokens = input.reflectionsForDropper.reduce(
    (s, r) => s + estimateStringTokens(reflectionToSummaryLine(r)),
    0
  );
  const commitDropperResult = (droppedIds) => {
    const latestReflectionCoverageId = isManualMode(runtime.config) ? input.pending?.reflection?.coversUpToId : latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
    const effectiveReflectionCoverageId = sameRunReflectionCoverageId ?? latestReflectionCoverageId;
    const coversUpToId = earlierCoverageMarkerId(
      entries,
      observationCoverageId,
      effectiveReflectionCoverageId
    );
    const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : void 0;
    if (data && coversUpToId) {
      if (isManualMode(runtime.config)) {
        if (!runtime.isGenerationActive(generation) || !branchStillOwned(generation, ctx)) return "abort";
        savePendingDropped(sessionId, { coversUpToId, data });
      } else {
        if (!appendEntry(pi, runtime, generation, OM_OBSERVATIONS_DROPPED, data, ctx)) return "abort";
      }
      runtime.advanceCursor("dropper", coversUpToId, "recorded");
    } else {
      runtime.advanceCursor(
        "dropper",
        pressureReached ? entries.at(-1)?.id ?? "unknown" : coversUpToId ?? observationCoverageId ?? entries.at(-1)?.id ?? "unknown",
        "empty",
        pressureReached ? pressurePoolSignature : void 0
      );
    }
    return "continue";
  };
  const runShrunkBatches = async (best) => {
    const bestModel = best.resolved.model;
    const stageModelForBatch = best.resolved.source === "candidate" ? best.resolved.candidateConfig : void 0;
    const poolTokens = input.newObservations.reduce(
      (s, o) => s + (typeof o.tokenCount === "number" ? o.tokenCount : 0),
      0
    );
    const globalMaxDrops = maxDropCountForPool(
      input.newObservations,
      poolTokens,
      runtime.config.observationsPoolMaxTokens,
      runtime.config.dropperPoolFullnessThreshold
    );
    if (globalMaxDrops <= 0) return commitDropperResult(void 0);
    const batchFixedOverhead = input.summaryTokens + dropperReflectionsTokens + dropperStaticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const batchBudget = workerInputBudget(best.ctx, bestModel);
    const itemBudget = batchBudget - batchFixedOverhead;
    if (itemBudget <= 0) return "abort";
    const batchCoverageById = reflectionCoverageMap(
      input.newObservations,
      input.reflectionsForDropper
    );
    const batchItemTokens = (o) => estimateStringTokens(
      observationToDropperLine(o, coverageTierForObservation(o, batchCoverageById))
    );
    const batches = planPrefixBatches(input.newObservations, batchItemTokens, itemBudget);
    if (input.newObservations.length > 0) {
      const oversized = batches.find(
        (batch2) => batch2.reduce((s, o) => s + batchItemTokens(o), 0) + batchFixedOverhead > batchBudget
      );
      if (oversized) return "abort";
    }
    const planned = batches.length > 0 ? batches : [[]];
    if (planned.length > WORKER_SHRINK_MAX_BATCHES) {
      debugLog("dropper.batch_cap", {
        batchCount: planned.length,
        maxBatches: WORKER_SHRINK_MAX_BATCHES,
        candidateCount: input.newObservations.length,
        model: `${bestModel.provider}/${bestModel.id}`
      });
      runtime.tryEmitWorkerInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: dropper deferring ${input.newObservations.length} candidates (${planned.length} fit-to-window batches exceeds the per-run limit of ${WORKER_SHRINK_MAX_BATCHES}; a larger dropper model would clear the pool)`
      );
      return "abort";
    }
    debugLog("dropper.batch_plan", {
      batchCount: planned.length,
      batchSizes: planned.map((b) => b.length),
      candidateCount: input.newObservations.length,
      model: `${bestModel.provider}/${bestModel.id}`
    });
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: dropper batching ${input.newObservations.length} candidates into ${planned.length} fit-to-window batches on ${bestModel.provider}/${bestModel.id}`
    );
    const seen = /* @__PURE__ */ new Set();
    const mergedProposals = [];
    const queue = [...planned];
    const isSessionBest = best.resolved.source !== "candidate";
    let batchRuns = 0;
    const voidBatchedRun = (error) => {
      const candidateConfig = stageModelForBatch;
      runtime.recordRetryableError(candidateConfig, error, "dropper");
      if (!candidateConfig) runtime.recordDeterministicError(bestModel, error, "dropper");
      debugLog("dropper.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        discardedCount: getDiscardedCount(error)
      });
      runtime.recordConsolidationStageError(ctx, "dropper", error);
      return "abort";
    };
    while (queue.length > 0) {
      const batch2 = queue.shift();
      if (!batch2 || batch2.length === 0) continue;
      if (!runtime.isGenerationActive(generation)) return "abort";
      batchRuns += 1;
      if (batchRuns > WORKER_SHRINK_MAX_BATCHES) {
        debugLog("dropper.batch_cap", {
          batchRuns,
          maxBatches: WORKER_SHRINK_MAX_BATCHES,
          candidateCount: input.newObservations.length,
          model: `${bestModel.provider}/${bestModel.id}`
        });
        return "abort";
      }
      debugLog("dropper.batch_start", {
        batchIndex: batchRuns,
        batchCount: planned.length,
        batchCandidateCount: batch2.length,
        model: `${bestModel.provider}/${bestModel.id}`
      });
      try {
        const { runDropper: runDropper2 } = await Promise.resolve().then(() => (init_offline_dropper(), offline_dropper_exports));
        const proposed = await runWorkerAttempt(
          "dropper",
          runtime.config.workerAttemptTimeoutMs,
          generation.signal,
          (signal) => runDropper2({
            model: bestModel,
            apiKey: best.resolved.apiKey,
            headers: withProviderAttributionHeaders(bestModel, best.resolved.headers, sessionId),
            env: best.resolved.env,
            reflections: input.reflectionsForDropper,
            observations: batch2,
            existingObservationsSummary: input.existingObservationsSummary || void 0,
            budgetTokens: runtime.config.observationsPoolMaxTokens,
            skipFullness: runtime.config.dropperPoolFullnessThreshold,
            pressure: { tokens: poolTokens, maxDrops: globalMaxDrops },
            rawProposals: true,
            maxOutputTokens: workerOutputAllowance(best.ctx, bestModel),
            maxTurns: runtime.config.agentMaxTurns,
            thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForBatch),
            providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
            signal,
            modelRegistry: ctx.modelRegistry,
            sessionId,
            cacheRetention: runtime.config.cacheRetention
          })
        );
        if (!runtime.isGenerationActive(generation)) return "abort";
        for (const id of proposed ?? []) {
          if (!seen.has(id)) {
            seen.add(id);
            mergedProposals.push(id);
          }
        }
      } catch (error) {
        if (!runtime.isGenerationActive(generation)) return "abort";
        if (isStaleExtensionContextError(error)) {
          debugLog("dropper.stale_ctx", { error: String(error) });
          return "abort";
        }
        if (!isSessionBest && error instanceof WorkerStreamError && (error.lengthCut || error.turnCapExhausted) && batch2.length > 1) {
          const mid = Math.max(1, Math.floor(batch2.length / 2));
          queue.unshift(batch2.slice(0, mid), batch2.slice(mid));
          debugLog("dropper.batch_split", {
            batchCandidateCount: batch2.length,
            model: `${bestModel.provider}/${bestModel.id}`
          });
          continue;
        }
        return voidBatchedRun(error);
      }
    }
    const selected = selectDropCandidates(
      mergedProposals,
      input.newObservations,
      globalMaxDrops,
      input.reflectionsForDropper
    );
    return commitDropperResult(selected.length > 0 ? selected : void 0);
  };
  let bestFit;
  let sawAttemptError = false;
  let attempt = 0;
  let sizeSkips = 0;
  while (attempt < MAX_STAGE_ATTEMPTS) {
    const resolved = await resolveModel("dropper");
    if (!runtime.isGenerationActive(generation)) return "abort";
    if (!resolved) {
      if (bestFit && !sawAttemptError) return runShrunkBatches(bestFit);
      return "abort";
    }
    runtime.tryEmitWorkerInfo(
      ctx.hasUI,
      ctx.ui,
      `Observational memory: dropper running (~${input.effectiveDropTokens.toLocaleString()} tokens accumulated, ~${input.dropperInputTokens.toLocaleString()}-token input)`
    );
    const stageModelForThinking = resolved.source === "candidate" ? resolved.candidateConfig : void 0;
    const effectiveDropCtx = effectiveContextWindow(resolved.model, stageModelForThinking);
    if (!bestFit || effectiveDropCtx > bestFit.ctx) bestFit = { resolved, ctx: effectiveDropCtx };
    const dropperEstimatedInput = input.dropperNewObsTokens + dropperReflectionsTokens + input.summaryTokens + dropperStaticTokens + WORKER_TURN_HEADROOM_TOKENS;
    const dropperInputBudget = workerInputBudget(effectiveDropCtx, resolved.model);
    if (dropperEstimatedInput > dropperInputBudget) {
      debugLog("dropper.context_window_exceeded", {
        estimatedInput: dropperEstimatedInput,
        inputBudget: dropperInputBudget,
        newObsTokens: input.dropperNewObsTokens,
        reflectionsTokens: dropperReflectionsTokens,
        summaryTokens: input.summaryTokens,
        staticTokens: dropperStaticTokens,
        effectiveCtx: effectiveDropCtx,
        model: `${resolved.model.provider}/${resolved.model.id}`
      });
      runtime.skipOversizedForCycle(oversizedIdentityForSkip(resolved));
      runtime.tryEmitInfo(
        ctx.hasUI,
        ctx.ui,
        `Observational memory: dropper skipping ${resolved.model.provider}/${resolved.model.id} (context window ${effectiveDropCtx.toLocaleString()} too small for ~${dropperEstimatedInput.toLocaleString()}-token input)`
      );
      sizeSkips += 1;
      if (sizeSkips > MAX_SIZE_SKIP_CONTINUATIONS) {
        if (bestFit && !sawAttemptError) return runShrunkBatches(bestFit);
        return "abort";
      }
      continue;
    }
    try {
      attempt += 1;
      const { runDropper: runDropper2 } = await Promise.resolve().then(() => (init_offline_dropper(), offline_dropper_exports));
      const droppedIds = await runWorkerAttempt(
        "dropper",
        runtime.config.workerAttemptTimeoutMs,
        generation.signal,
        (signal) => runDropper2({
          model: resolved.model,
          apiKey: resolved.apiKey,
          headers: withProviderAttributionHeaders(
            resolved.model,
            resolved.headers,
            sessionId
          ),
          env: resolved.env,
          maxOutputTokens: workerOutputAllowance(effectiveDropCtx, resolved.model),
          reflections: input.reflectionsForDropper,
          observations: input.newObservations,
          existingObservationsSummary: input.existingObservationsSummary || void 0,
          budgetTokens: runtime.config.observationsPoolMaxTokens,
          skipFullness: runtime.config.dropperPoolFullnessThreshold,
          maxTurns: runtime.config.agentMaxTurns,
          thinkingLevel: stageThinkingLevel(runtime, "dropper", stageModelForThinking),
          providerIdleTimeoutMs: runtime.config.providerIdleTimeoutMs,
          signal,
          modelRegistry: ctx.modelRegistry,
          sessionId,
          cacheRetention: runtime.config.cacheRetention
        })
      );
      if (!runtime.isGenerationActive(generation)) return "abort";
      return commitDropperResult(droppedIds);
    } catch (error) {
      if (!runtime.isGenerationActive(generation)) return "abort";
      if (isStaleExtensionContextError(error)) {
        debugLog("dropper.stale_ctx", { error: String(error) });
        return "abort";
      }
      if (error instanceof WorkerStreamError && error.lengthCut && !error.turnCapExhausted) {
        const candidateConfig2 = stageModelForThinking;
        if (candidateConfig2) {
          const outputAllowance = workerOutputAllowance(effectiveDropCtx, resolved.model);
          debugLog("dropper.output_allowance_exceeded", {
            outputAllowance,
            model: `${resolved.model.provider}/${resolved.model.id}`,
            discardedCount: getDiscardedCount(error)
          });
          runtime.skipOversizedForCycle(candidateConfig2);
          runtime.tryEmitInfo(
            ctx.hasUI,
            ctx.ui,
            `Observational memory: dropper skipping ${resolved.model.provider}/${resolved.model.id} (output allowance ~${outputAllowance.toLocaleString()} tokens too small for this input)`
          );
          continue;
        }
      }
      if (!(error instanceof WorkerStreamError && (error.turnCapExhausted || error.lengthCut)))
        sawAttemptError = true;
      const candidateConfig = stageModelForThinking;
      runtime.recordRetryableError(candidateConfig, error, "dropper");
      if (!candidateConfig) runtime.recordDeterministicError(resolved.model, error, "dropper");
      debugLog("dropper.error", {
        error: String(error),
        retryable: isRetryableError(error),
        deterministic: isDeterministicError(error),
        cooldownWorthy: isCooldownWorthyError(error),
        // Drop candidates recorded before the run failed and discarded with it.
        discardedCount: getDiscardedCount(error)
      });
      if (!candidateConfig && (error instanceof WorkerAttemptTimeoutError || error instanceof WorkerStreamError && (error.turnCapExhausted || error.lengthCut)))
        break;
      continue;
    }
  }
  runtime.recordConsolidationStageError(
    ctx,
    "dropper",
    new Error("Dropper: all model candidates exhausted")
  );
  return "abort";
}

// modules/blackhole/src/commands/pi-vcc.ts
init_project_trust();
import { join as join11 } from "node:path";

// modules/blackhole/src/hooks/before-compact.ts
import { convertToLlm as convertToLlm2 } from "@earendil-works/pi-coding-agent";

// modules/blackhole/src/core/format.ts
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

// modules/blackhole/src/core/notification-evidence.ts
var MAX_RECORD = 64 * 1024;
var MAX_TOTAL = 4 * 1024 * 1024;
var terminal = /* @__PURE__ */ new Set(["completed", "failed", "cancelled", "timed_out", "aborted", "skipped"]);
var states = /* @__PURE__ */ new Set(["accepted", "queued", "running", "cancelling", ...terminal]);

// modules/blackhole/src/core/compaction-chain.ts
import {
  buildSessionContext,
  convertToLlm,
  estimateTokens
} from "@earendil-works/pi-coding-agent";

// modules/blackhole/src/hooks/before-compact.ts
init_model_budget();
init_unified_config();

// modules/blackhole/src/core/session-lines.ts
var SESSION_SCAN_MAX_BYTES = 32 * 1024 * 1024;
var SESSION_LINE_MAX_BYTES = 1024 * 1024;
var CHUNK_SIZE = 64 * 1024;

// modules/blackhole/src/hooks/before-compact.ts
var PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";
var migrationNotifyCount = /* @__PURE__ */ new Map();
function notifyMigrationReminder(sessionId, notify) {
  const count = migrationNotifyCount.get(sessionId) ?? 0;
  if (count >= 2) return;
  if (!configFileNeedsMigration()) return;
  migrationNotifyCount.set(sessionId, count + 1);
  notify("blackhole: Use `/blackhole configure` to save your updated configuration.", "info");
}
var formatTokens = (n) => {
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};
var formatCompactionStats = (stats) => {
  const parts = [`${stats.summarized} source entries processed`];
  parts.push(`tail kept ${stats.keptUserTurns}/${stats.totalUserTurns} user turns`);
  if (stats.smartKeepAdjusted) {
    parts.push(`smart keep:${stats.smartFromKeep}\u2192${stats.keptUserTurns}`);
  }
  if (stats.keepFallbackToCompactAll) {
    parts.push(`compact-all`);
  }
  return `blackhole: ${parts.join("; ")} (~${formatTokens(stats.keptTokensEst)} tok).`;
};

// modules/blackhole/src/commands/pi-vcc.ts
var manualRefusalMessage = (reason) => reason === "already_compacted" ? "blackhole: already compacted \u2014 nothing new to compact since the last summary" : "blackhole: nothing to compact yet \u2014 Pi's keep-recent budget still covers this branch";
function nonTuiSettingsText(runtime, ctx, globalDir) {
  const trusted = isProjectLayerAdmitted(ctx.cwd);
  const c = runtime.config;
  return [
    "blackhole settings: the interactive settings UI is only available in the TUI.",
    `Current: compaction=${String(c.compaction)}, memory=${String(c.memory)}.`,
    `Global config: ${join11(globalDir, "pi-blackhole-config.json")}`,
    `Project config: ${trusted ? join11(ctx.cwd ?? "", ".pi", "pi-blackhole-config.json") : "ignored (project not trusted)"}`,
    "Supported here: /blackhole om-on, /blackhole om-off, /blackhole-memory status; edit the JSON file for other keys."
  ].join("\n");
}
var registerPiVccCommand = (pi, runtime) => {
  const prefixMatch = (value, prefix) => {
    return value.toLowerCase().startsWith(prefix.toLowerCase());
  };
  pi.registerCommand("blackhole", {
    description: "Manual compact with structural summary. Subcommands: [settings] config overlay, [changelog] display changelog, [cleanup] remove orphaned files, [om-off]/[om-on] disable/enable observational memory.",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        {
          value: "settings",
          label: "Open configuration overlay [settings]"
        },
        {
          value: "changelog",
          label: "Display changelog [changelog]"
        },
        {
          value: "cleanup",
          label: "Remove orphaned pending files [cleanup]"
        },
        { value: "om-off", label: "Disable observational memory [om-off]" },
        { value: "om-on", label: "Enable observational memory [om-on]" }
      ];
      if (!prefix) return subcommands;
      return subcommands.filter(
        (s) => prefixMatch(s.value, prefix) || s.value === "settings" && prefixMatch("configure", prefix)
      );
    },
    handler: async (args, ctx) => {
      recordProjectTrust(ctx.cwd, ctx);
      runtime.ensureConfig(ctx.cwd ?? process.cwd(), (msg) => ctx.ui.notify(msg, "warning"));
      const sessionId = ctx.sessionManager.getSessionId();
      const trimmed = (typeof args === "string" ? args : "").trim();
      if (trimmed === "configure" || trimmed === "settings") {
        const { openBlackholeSettings: openBlackholeSettings2, config: config2, GLOBAL_CONFIG_DIR: GLOBAL_CONFIG_DIR2 } = await Promise.resolve().then(() => (init_blackhole_settings(), blackhole_settings_exports));
        if (ctx.mode !== "tui") {
          ctx.ui.notify(nonTuiSettingsText(runtime, ctx, GLOBAL_CONFIG_DIR2), "info");
          return;
        }
        try {
          await openBlackholeSettings2(ctx);
        } catch (error) {
          ctx.ui.notify(`Settings UI failed: ${error?.message ?? String(error)}`, "error");
          return;
        }
        const resolved = config2.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR2);
        config2.notifyWarnings(resolved, (message) => ctx.ui.notify(message, "warning"));
        runtime.config = resolved.config;
        runtime.configLoaded = true;
        return;
      }
      if (trimmed === "changelog") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("blackhole changelog: the changelog viewer is only available in the TUI.", "info");
          return;
        }
        const { openChangelogView: openChangelogView2 } = await Promise.resolve().then(() => (init_changelog(), changelog_exports));
        await openChangelogView2(ctx);
        return;
      }
      if (trimmed === "cleanup") {
        const { handleCleanup: handleCleanup2 } = await Promise.resolve().then(() => (init_cleanup2(), cleanup_exports));
        await handleCleanup2(ctx);
        return;
      }
      if (trimmed === "om-off" || trimmed === "om-on") {
        const memory = trimmed === "om-on";
        const { config: config2, GLOBAL_CONFIG_DIR: GLOBAL_CONFIG_DIR2 } = await Promise.resolve().then(() => (init_blackhole_settings(), blackhole_settings_exports));
        let saved = true;
        try {
          config2.patchScope({ memory }, "global", ctx.cwd, GLOBAL_CONFIG_DIR2);
        } catch {
          saved = false;
        }
        if (!saved) {
          runtime.config = { ...runtime.config, memory };
          ctx.ui.notify(
            "Failed to save config \u2014 the config file may be read-only (e.g., managed by Nix). Applied to this session's runtime only; it is not persisted and may be overridden by env/session settings on the next reload.",
            "warning"
          );
          return;
        }
        const resolved = config2.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR2);
        config2.notifyWarnings(resolved, (message) => ctx.ui.notify(message, "warning"));
        runtime.config = resolved.config;
        ctx.ui.notify(
          memory ? "Observational memory enabled." : "Observational memory disabled. Use /blackhole om-on to re-enable.",
          "info"
        );
        return;
      }
      const SUBCOMMAND_NAMES = ["configure", "settings", "changelog", "cleanup", "om-off", "om-on"];
      const nearMiss = SUBCOMMAND_NAMES.find(
        (name) => trimmed.toLowerCase().startsWith(name.toLowerCase()) && trimmed.length > name.length
      );
      if (nearMiss) {
        ctx.ui.notify(
          `/blackhole ${nearMiss} accepts no arguments. Did you mean "/blackhole ${nearMiss}"?`,
          "warning"
        );
        return;
      }
      const followUpPrompt = trimmed ? trimmed : null;
      ctx.compact({
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        onComplete: () => {
          const stats = runtime.compactionStats;
          if (stats) {
            ctx.ui.notify(formatCompactionStats(stats), "info");
          } else {
            ctx.ui.notify("Compacted with blackhole", "info");
          }
          notifyMigrationReminder(sessionId, (msg, level) => ctx.ui.notify(msg, level));
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {
              });
            } catch {
            }
          }
        },
        onError: (err) => {
          const message = String(err?.message ?? err);
          if (message.startsWith("Nothing to compact")) {
            ctx.ui.notify(manualRefusalMessage("too_small"), "info");
          } else if (message === "Already compacted") {
            ctx.ui.notify(manualRefusalMessage("already_compacted"), "info");
          } else if (message === "Compaction cancelled") {
          } else {
            ctx.ui.notify(`Compaction failed: ${message}`, "error");
          }
        }
      });
    }
  });
};

// plan/review-20261012-evidence/verify-blackhole/probe.ts
var [kind, mode] = process.argv.slice(2);
var fault = mode === "fault";
var agent = resolve4(process.env.PI_CODING_AGENT_DIR);
assert.ok(agent.includes(`${sep3}verify-blackhole${sep3}`));
assert.equal(process.env.PI_BLACKHOLE_PASSIVE, "true");
globalThis.fetch = async () => {
  throw Error("Network forbidden");
};
var sid = "verify-live-session";
var dir = join12(agent, "pi-blackhole");
var main = join12(dir, `${sid}-pending.json`);
var stale = join12(dir, `${sid}-pending.stale.json`);
var sessions = join12(agent, "sessions");
var session = join12(sessions, "live.jsonl");
console.log(`Progress: starting ${kind} ${mode}, pid=${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-10-12T00:00:00Z", cwd: agent }) + "\n");
var original = { writeFileSync: fs.writeFileSync, readFileSync: fs.readFileSync, unlinkSync: fs.unlinkSync, renameSync: fs.renameSync, mkdirSync: fs.mkdirSync };
var armed = false;
var errors = 0;
var reads = 0;
var inside = (path) => {
  const r = resolve4(String(path));
  return r === agent || r.startsWith(agent + sep3);
};
fs.writeFileSync = ((path, ...a) => {
  assert.ok(inside(path), "write outside isolated agent");
  if (resolve4(String(path)) === main && armed) {
    armed = false;
    errors++;
    console.log("Injected ENOSPC at pending main write");
    throw Object.assign(Error("Injected ENOSPC"), { code: "ENOSPC" });
  }
  return original.writeFileSync(path, ...a);
});
fs.readFileSync = ((path, ...a) => {
  if (resolve4(String(path)) === session) {
    reads++;
    if (armed) {
      errors++;
      console.log("Injected EACCES at live session header read");
      throw Object.assign(Error("Injected EACCES"), { code: "EACCES" });
    }
  }
  return original.readFileSync(path, ...a);
});
fs.unlinkSync = ((path) => {
  assert.ok(inside(path), "unlink outside isolated agent");
  return original.unlinkSync(path);
});
fs.renameSync = ((a, b) => {
  assert.ok(inside(a) && inside(b), "rename outside isolated agent");
  return original.renameSync(a, b);
});
fs.mkdirSync = ((path, ...a) => {
  assert.ok(inside(path), "mkdir outside isolated agent");
  return original.mkdirSync(path, ...a);
});
syncBuiltinESMExports();
var batch = (id, cover) => ({ coversUpToId: cover, data: { coversUpToId: cover, observations: [{ id, content: id, timestamp: "2026-10-12T00:00:00Z", relevance: "high", sourceEntryIds: [cover], tokenCount: 5 }] } });
try {
  if (kind === "pending-helper") {
    savePendingObservation(sid, batch("aaaaaaaaaaaa", "raw-a"));
    armed = fault;
    savePendingObservation(sid, batch("bbbbbbbbbbbb", "raw-b"));
    if (fault) {
      assert.equal(fs.existsSync(main), false);
      assert.ok(fs.readFileSync(stale, "utf8").includes("aaaaaaaaaaaa"));
    }
    writePendingCursors(sid, { observer: { entryId: "raw-b", state: "recorded" } });
    writePendingCursors(sid, { observer: { entryId: "raw-b", state: "recorded" } });
    const state = readPendingState(sid);
    assert.equal(state.observationBatches?.length ?? 0, fault ? 0 : 2);
    assert.equal(state.cursors.observer.entryId, "raw-b");
    assert.equal(fs.readFileSync(stale, "utf8").includes("aaaaaaaaaaaa"), !fault);
    console.log(JSON.stringify({ kind, mode, errors, batches: state.observationBatches?.length ?? 0, cursor: state.cursors.observer, backupContainsA: fs.readFileSync(stale, "utf8").includes("aaaaaaaaaaaa") }));
  } else if (kind === "pending-caller") {
    const runtime = new Runtime(agent);
    runtime.configLoaded = true;
    Object.assign(runtime.config, { memory: true, compaction: "manual", observeAfterTokens: 1, reflectAfterTokens: 1e6, observationsPoolMaxTokens: 1e6, showWorkerNotifications: true, debug: false, workerAttemptTimeoutMs: 5e3 });
    runtime.resolveModel = async () => ({ ok: true, source: "candidate", candidateConfig: { provider: "synthetic", id: "offline" }, model: { provider: "synthetic", id: "offline", contextWindow: 1e6 }, apiKey: "dummy" });
    const entries = [{ type: "message", id: "raw-b", parentId: null, timestamp: "2026-10-12T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Independent observer evidence ".repeat(30) }] } }];
    const notices = [];
    const ctx = { cwd: agent, hasUI: true, ui: { notify: (s) => notices.push(s) }, modelRegistry: {}, sessionManager: { getBranch: () => entries, getSessionId: () => sid, getLeafId: () => entries.at(-1).id } };
    const pi = { appendEntry() {
      throw Error("manual must not append");
    } };
    armed = fault;
    await runConsolidationPipeline(pi, runtime, ctx, runtime.captureGeneration(sid));
    await new Promise((r) => queueMicrotask(r));
    assert.equal(globalThis.__workerCalls, 1, "synthetic worker must really be called");
    const state = readPendingState(sid);
    assert.equal(state.observationBatches?.length ?? 0, fault ? 0 : 1);
    assert.equal(state.cursors?.observer?.entryId, "raw-b");
    assert.equal(state.cursors?.observer?.state, "recorded");
    assert.ok(notices.some((s) => s.includes("observer running on")), "running notice owns the once-per-phase gate");
    assert.equal(notices.some((s) => s.includes("1 observation recorded")), false, "recorded notice suppressed by real info gate");
    const reloaded = new Runtime(agent);
    Object.assign(reloaded.config, runtime.config);
    reloaded.loadCursorsFromPending(sid);
    assert.equal(anyStageDue(entries, reloaded, void 0), false);
    const before = globalThis.__workerCalls;
    await runConsolidationPipeline(pi, reloaded, ctx, reloaded.captureGeneration(sid));
    await new Promise((r) => queueMicrotask(r));
    assert.equal(globalThis.__workerCalls, before, "cursor suppresses replay after reload");
    console.log(JSON.stringify({ kind, mode, errors, workerCalls: before, batches: state.observationBatches?.length ?? 0, cursor: state.cursors.observer, reloadedDue: false, reloadedWorkerCalls: globalThis.__workerCalls, notices }));
  } else if (kind === "orphan-helper" || kind === "orphan-command") {
    savePendingObservation(sid, batch("aaaaaaaaaaaa", "raw-a"));
    assert.equal(analyzeOrphaned().active.length, 1);
    armed = fault;
    if (kind === "orphan-helper") {
      const report = analyzeOrphaned();
      assert.equal(report.orphaned.length, fault ? 1 : 0);
      const deleted = deleteOrphanedBatch(report.orphaned);
      assert.equal(deleted, fault ? 1 : 0);
      console.log(JSON.stringify({ kind, mode, errors, reads, active: report.active.length, orphaned: report.orphaned.length, deleted, pendingExists: fs.existsSync(main), sessionExists: fs.existsSync(session) }));
    } else {
      const notices = [], rendered = [];
      let opened = 0;
      const ctx = { cwd: agent, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sid }, ui: { notify: (s) => notices.push(s), custom: async (factory) => {
        opened++;
        let result;
        const component = factory({}, { fg: (_, s) => s, bg: (_, s) => s }, {}, (r) => {
          result = r;
        });
        rendered.push(...component.render(80));
        component.handleInput("\r");
        return result;
      } } };
      const runtime = new Runtime(agent);
      runtime.configLoaded = true;
      let command;
      registerPiVccCommand({ registerCommand: (name, spec) => {
        assert.equal(name, "blackhole");
        command = spec;
      } }, runtime);
      assert.ok(command);
      await command.handler("cleanup", ctx);
      assert.equal(opened, fault ? 1 : 0);
      if (fault) {
        assert.ok(rendered.some((s) => s.includes("Orphaned Pending Files")));
        assert.ok(notices.some((s) => s.includes("All 1 orphaned pending file removed")));
      }
      console.log(JSON.stringify({ kind, mode, errors, reads, opened, rendered, notices, pendingExists: fs.existsSync(main), sessionExists: fs.existsSync(session), liveContextSession: sid }));
    }
    assert.equal(fs.existsSync(main), !fault);
    assert.equal(fs.existsSync(session), true);
  } else throw Error("unknown probe");
  assert.equal(errors, fault ? 1 : 0);
} finally {
  Object.assign(fs, original);
  syncBuiltinESMExports();
  fs.rmSync(agent, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: "isolated agent removed", agentExists: fs.existsSync(agent) }));
}
console.log("Progress: probe complete; mocks restored; no model/network used");
