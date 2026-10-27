import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Why the SQLite process could not be started; `humanMessage` may name the override variable, `message` never does. */
export class SqliteStartupError extends Error {
  constructor(message: string, readonly humanMessage: string = message) {
    super(message);
  }
}

export const NODE_OVERRIDE_ENV = "PI_SQLITE_NODE";
const REQUIREMENT = "22.22.2, 24.15.0 or newer (26 and later included)";

/** Mirrors the root package.json `engines.node` range, which is also what `node:sqlite` needs. */
export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major >= 26) return true;
  const minimum = major === 24 ? [24, 15, 0] : major === 22 ? [22, 22, 2] : undefined;
  if (!minimum) return false;
  return minor !== minimum[1] ? minor > minimum[1]! : patch >= minimum[2]!;
}

export interface NodeLookup {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  versions: Record<string, string | undefined>;
  isFile(path: string): boolean;
  /** The candidate's `process.versions.node`, or undefined when it cannot run. */
  probe(path: string): Promise<string | undefined>;
}

const defaultLookup: NodeLookup = {
  platform: process.platform,
  get env() { return process.env; },
  execPath: process.execPath,
  versions: process.versions as Record<string, string | undefined>,
  isFile(path) { try { return statSync(path).isFile(); } catch { return false; } },
  probe: path => new Promise(resolve => {
    execFile(path, ["-p", "process.versions.node"], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  }),
};

function isNodeHost({ versions, execPath }: NodeLookup): boolean {
  if (versions.bun || versions.deno || versions.electron) return false;
  return /^node(\.exe)?$/i.test(win32.basename(execPath));
}

function pathCandidates(lookup: NodeLookup): string[] {
  const windows = lookup.platform === "win32";
  const raw = (windows ? Object.entries(lookup.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : lookup.env.PATH) ?? "";
  const name = windows ? "node.exe" : "node";
  const flavor = windows ? win32 : posix;
  const found: string[] = [];
  for (const entry of raw.split(flavor.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const candidate = flavor.join(directory, name);
    if (!found.includes(candidate) && lookup.isFile(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * The Node.js executable that runs the SQLite process: the host itself when it is Node, otherwise the
 * `PI_SQLITE_NODE` override or the first supported `node` on PATH (hosts such as Bun cannot run `node:sqlite`
 * or Node-only flags). Never falls back to the host binary.
 */
export async function findNodeExecutable(lookup: NodeLookup = defaultLookup): Promise<string> {
  if (isNodeHost(lookup)) {
    const version = lookup.versions.node ?? "";
    if (isSupportedNodeVersion(version)) return lookup.execPath;
    throw new SqliteStartupError(`The SQLite helper needs Node.js ${REQUIREMENT}, but this host runs ${version || "an unknown version"}.`);
  }
  const override = lookup.env[NODE_OVERRIDE_ENV]?.trim();
  const candidates = override ? [override] : pathCandidates(lookup);
  const rejected: string[] = [];
  for (const candidate of candidates) {
    const version = lookup.isFile(candidate) ? await lookup.probe(candidate) : undefined;
    if (version && isSupportedNodeVersion(version)) return candidate;
    rejected.push(version ? `${candidate} (${version})` : `${candidate} (cannot run)`);
  }
  const detail = rejected.length ? ` Rejected: ${rejected.join(", ")}.` : "";
  throw new SqliteStartupError(
    `The SQLite helper needs Node.js ${REQUIREMENT} but none was found for this host.${detail}`,
    `The SQLite helper needs Node.js ${REQUIREMENT} on PATH, or ${NODE_OVERRIDE_ENV} pointing to one, but none was found for this host.${detail}`,
  );
}

let cached: Promise<string> | undefined;
/** Resolved once per process on success; a failure is retried so installing Node and reloading works. */
export function resolveNodeExecutable(): Promise<string> {
  cached ??= findNodeExecutable().catch(error => { cached = undefined; throw error; });
  return cached;
}
