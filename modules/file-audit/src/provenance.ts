import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Activity } from "./activity-window.js";
import { credentialPath, inside, safeRelative } from "./paths.js";

export interface Expected { hash?: string; absent?: boolean; historical: boolean }
export type Status = "matched" | "mismatch" | "expected-absent" | "missing" | "untracked" | "skipped" | "unavailable";
export interface Finding { path: string; status: Status; reason?: string; historical?: boolean }
export interface ScanResult { findings: Finding[]; bytes: number; metadataBytes: number; elapsedMs: number; error?: string }
export interface ScanOptions {
  signal?: AbortSignal; maxFileBytes?: number; maxTotalBytes?: number; maxMetadataBytes?: number; maxRecords?: number;
}
interface Budget { remaining: number; read: number }
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 8 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-metadata-object");
  return value as Record<string, unknown>;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid-metadata-array");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("invalid-metadata-hash");
  return value;
}
function reason(value: unknown): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("missing-review-reason");
}
function historical(row: Record<string, unknown>, native = false): boolean {
  if (row.historicalDeltaAudit === undefined) return false;
  if (row.historicalDeltaAudit !== "unavailable") throw new Error("invalid-historical-status");
  reason(row.localSnapshotReview);
  if (native) { reason(row.reason); hash(row.previousRecordedSha256); }
  return true;
}

/** Only active inventory sections are interpreted; historical narrative hashes are never expected values. */
export function expectedRecords(sources: unknown, adaptations: unknown, native: unknown, wanted: Set<string>, maxRecords = 50000): Map<string, Expected> {
  const src = object(sources), ad = object(adaptations), nt = object(native);
  const imports = new Map<string, string>(), active = new Map<string, Expected>(), expected = new Map<string, Expected>();
  let visited = 0;
  const visit = (value: unknown): Record<string, unknown> => {
    if (++visited > maxRecords) throw new Error("inventory-budget");
    return object(value);
  };
  const pathOf = (value: unknown): string => {
    if (!safeRelative(value)) throw new Error("unsafe-metadata-path");
    return value;
  };
  const add = (path: string, value: Expected, rootOverlap = false): void => {
    const prior = active.get(path);
    if (prior) {
      // The existing full verifier permits a rootFiles assertion for an already inventoried integration file.
      if (rootOverlap && !prior.absent && prior.hash === value.hash) return;
      throw new Error("duplicate-active-record");
    }
    active.set(path, value); if (wanted.has(path)) expected.set(path, value);
  };
  for (const value of rows(src.modules)) {
    const module = visit(value), name = module.module;
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) throw new Error("invalid-module-name");
    for (const file of rows(module.files)) {
      const row = visit(file), path = `modules/${name}/${pathOf(row.path)}`;
      if (imports.has(path)) throw new Error("duplicate-import");
      imports.set(path, hash(row.sha256));
    }
  }
  const overrides = new Map<string, Expected>();
  for (const [section, absent] of [["files", false], ["removedFiles", true]] as const) {
    for (const value of rows(ad[section] ?? (absent ? [] : undefined))) {
      const row = visit(value), path = pathOf(row.path);
      if (!imports.has(path) || overrides.has(path)) throw new Error("invalid-import-adaptation");
      if (hash(row.originalSha256) !== imports.get(path)) throw new Error("adaptation-origin-mismatch");
      reason(row.reason);
      overrides.set(path, { ...(absent ? { absent: true } : { hash: hash(row.sha256) }), historical: absent ? false : historical(row) });
    }
  }
  for (const [path, original] of imports) add(path, overrides.get(path) ?? { hash: original, historical: false });
  for (const value of rows(ad.addedFiles ?? [])) {
    const row = visit(value), path = pathOf(row.path); reason(row.reason);
    if (!/^(modules|tests)\//.test(path)) throw new Error("unsafe-added-path");
    add(path, { hash: hash(row.sha256), historical: false });
  }
  for (const value of rows(nt.modules)) {
    const module = visit(value), name = module.module;
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) throw new Error("invalid-native-name");
    reason(module.origin); reason(module.license);
    let entryFound = false;
    for (const file of rows(module.files)) {
      const row = visit(file), path = pathOf(row.path);
      if (!path.startsWith(`modules/${name}/`)) throw new Error("unsafe-native-path");
      if (path === module.entry) entryFound = true;
      add(path, { hash: hash(row.sha256), historical: historical(row, true) });
    }
    if (!entryFound) throw new Error("untracked-native-entry");
  }
  const rootPaths = new Set<string>();
  for (const value of rows(object(ad.localSourceSuiteFinalIntegration).rootFiles)) {
    const row = visit(value), path = pathOf(row.path);
    if (rootPaths.has(path)) throw new Error("duplicate-root-record");
    rootPaths.add(path);
    add(path, { hash: hash(row.sha256), historical: false }, true);
  }
  return expected;
}

function same(a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function code(error: unknown): string {
  const value = error as { code?: string; message?: string };
  // Never echo arbitrary file contents, provider output or OS diagnostic paths.
  return value?.code ?? (value instanceof Error && /^[a-z-]+$/.test(value.message) ? value.message : "inspection-failed");
}
/** Sanitized failure code safe to show the human (errno code or a fixed token; never file contents or paths). */
export const failureCode = code;
async function readBounded(path: string, root: string, budget: Budget, maxFile: number, signal: AbortSignal | undefined, text: boolean): Promise<string> {
  signal?.throwIfAborted();
  const lexical = resolve(root, path);
  if (!inside(root, lexical) || credentialPath(relative(root, lexical))) throw new Error("excluded-path");
  const canonical = await realpath(lexical);
  if (!inside(root, canonical) || credentialPath(relative(root, canonical))) throw new Error("outside-workspace");
  const beforePath = await lstat(canonical, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error("not-regular-file");
  if (beforePath.size > BigInt(maxFile)) throw new Error("file-budget");
  if (beforePath.size > BigInt(budget.remaining)) throw new Error("total-budget");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !same(beforePath, before)) throw new Error("file-changed");
    const digest = createHash("sha256"), chunks: Buffer[] = [];
    let count = 0;
    const buffer = Buffer.alloc(Math.min(65536, Math.max(1, maxFile)));
    while (BigInt(count) < before.size) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.length, Number(before.size - BigInt(count)), maxFile - count, budget.remaining);
      if (length <= 0) throw new Error("total-budget");
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      if (!bytesRead) throw new Error("file-changed");
      budget.read += bytesRead; budget.remaining -= bytesRead; count += bytesRead;
      if (text) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      else digest.update(buffer.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    if (!same(before, await handle.stat({ bigint: true })) || !same(before, await lstat(canonical, { bigint: true })) ||
        canonical !== await realpath(lexical)) throw new Error("file-changed");
    return text ? Buffer.concat(chunks, count).toString("utf8") : digest.digest("hex");
  } finally { await handle.close(); }
}

/** Workspace-relative path of the deepest existing ancestor, with the remaining segments appended so a
 *  missing or untracked leaf still yields a usable path. */
async function canonicalRelative(root: string, path: string): Promise<string> {
  const trailing: string[] = [];
  let head = resolve(path);
  for (;;) {
    let real: string | undefined;
    try { real = await realpath(head); } catch (error) {
      const parent = dirname(head);
      if ((code(error) !== "ENOENT" && code(error) !== "ENOTDIR") || parent === head) return relative(root, resolve(path)).replaceAll("\\", "/");
      trailing.unshift(basename(head));
      head = parent;
      continue;
    }
    return relative(root, join(real, ...trailing)).replaceAll("\\", "/");
  }
}

/** The caller's own spelling decides whether a candidate is inside the workspace: `realpath(cwd)` may expand
 *  filesystem aliases (Windows 8.3 short names, junctions, case differences) that the candidate paths still
 *  carry, and judging by the resolved root alone would report an in-workspace file as an escape. Only when the
 *  caller's spelling is unsafe is the real location consulted, so a genuinely outside spelling stays skipped
 *  and a lexical escape still reaches the canonical checks that report outside-workspace. */
async function candidateRelative(base: string, root: string, path: string): Promise<string> {
  const lexical = relative(base, path).replaceAll("\\", "/");
  if (safeRelative(lexical)) return lexical;
  const canonical = await canonicalRelative(root, path);
  return safeRelative(canonical) ? canonical : lexical;
}

export async function scan(cwd: string, candidates: readonly Activity[], options: ScanOptions = {}): Promise<ScanResult> {
  const start = performance.now(), findings: Finding[] = [];
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  const content: Budget = { remaining: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, read: 0 };
  const metadata: Budget = { remaining: maxMetadataBytes, read: 0 };
  let error: string | undefined;
  try {
    if (!candidates.length) return { findings, bytes: 0, metadataBytes: 0, elapsedMs: performance.now() - start };
    if (candidates.length > 500) throw new Error("candidate-budget");
    const base = resolve(cwd), root = await realpath(cwd);
    const relativePaths = await Promise.all(candidates.map(item => candidateRelative(base, root, item.path)));
    const docs: unknown[] = [];
    for (const name of ["sources", "adaptations", "native-modules"]) {
      const raw = await readBounded(`docs/${name}.json`, root, metadata, maxMetadataBytes, options.signal, true);
      try { docs.push(JSON.parse(raw.replace(/^\uFEFF/, ""))); } catch { throw new Error("invalid-metadata-json"); }
    }
    const expected = expectedRecords(docs[0], docs[1], docs[2], new Set(relativePaths), options.maxRecords);
    for (let i = 0; i < candidates.length; i++) {
      const path = candidates[i].path, rel = relativePaths[i], record = expected.get(rel);
      if (!safeRelative(rel) || credentialPath(rel)) { findings.push({ path, status: "skipped", reason: "excluded-path" }); continue; }
      if (options.signal?.aborted) { findings.push({ path, status: "unavailable", reason: "cancelled" }); continue; }
      if (!record) { findings.push({ path, status: "untracked" }); continue; }
      try {
        if (record.absent) {
          // A missing leaf must not authorize traversal through a replaced external parent.
          for (let parent = dirname(resolve(root, rel)); inside(root, parent); parent = dirname(parent)) {
            try {
              if (!inside(root, await realpath(parent))) throw new Error("outside-workspace");
              break;
            } catch (err) { if (code(err) !== "ENOENT") throw err; }
          }
          try { await lstat(resolve(root, rel)); findings.push({ path, status: "mismatch", reason: "expected-absent" }); }
          catch (err) { if (code(err) !== "ENOENT") throw err; findings.push({ path, status: "expected-absent" }); }
        } else {
          const actual = await readBounded(rel, root, content, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, options.signal, false);
          findings.push({ path, status: actual === record.hash ? "matched" : "mismatch", historical: record.historical });
        }
      } catch (err) {
        const why = options.signal?.aborted ? "cancelled" : code(err);
        findings.push({ path, status: why === "ENOENT" ? "missing" : "unavailable", reason: why });
      }
    }
  } catch (err) {
    error = options.signal?.aborted ? "cancelled" : code(err);
    for (const item of candidates) findings.push({ path: item.path, status: "unavailable", reason: error });
  }
  return { findings, bytes: content.read, metadataBytes: metadata.read, elapsedMs: performance.now() - start, ...(error ? { error } : {}) };
}
