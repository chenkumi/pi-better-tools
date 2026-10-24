import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileToolError } from "./errors.js";

const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

// Only reinterpret shell drive paths on Windows. UNC and mixed-separator paths
// must keep their native meaning; /c is a real POSIX directory elsewhere.
function normalizeWindowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
  return match ? `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}` : path;
}

function fileUrlToPath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    // Node reports malformed escapes and encoded separators as a raw URIError / TypeError; surface the tool's own error.
    throw new FileToolError("INVALID_ARGUMENT", `The file URL is not valid: ${url.length > 200 ? `${url.slice(0, 200)}…` : url}`, {
      recovery: "Pass a plain path, or a well-formed file:// URL without malformed percent escapes or encoded path separators.",
    });
  }
}

function normalizeLocalPath(path: string): string {
  if (process.platform === "win32") path = normalizeWindowsShellPath(path);
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  // Node performs URL decoding and rejects malformed/encoded separators. Never
  // silently turn a file URL into a relative filename on the wrong drive.
  return /^file:\/\//.test(path) ? fileUrlToPath(path) : path;
}

export function normalizeToolPath(input: string): string {
  const path = input.startsWith("@") ? input.slice(1) : input;
  return normalizeLocalPath(path.replace(UNICODE_SPACES, " "));
}

function resolveAgainst(path: string, cwd: string): string {
  // cwd is an actual workspace path, not model input. Keep literal @ and Unicode
  // spaces there, while still supporting a shell path or file URL as the base.
  return isAbsolute(path) ? resolve(path) : resolve(normalizeLocalPath(cwd), path);
}

export function resolveToolPath(input: string, cwd: string): string {
  const normalized = resolveAgainst(normalizeToolPath(input), cwd);
  // The @ / Unicode-space rewrite is a convenience for model-typed paths. If the literal
  // path exists (e.g. macOS screenshot names with U+202F, or an @scope directory), it wins.
  if (input.startsWith("@") || /[  -   　]/.test(input)) {
    try {
      const literal = resolveAgainst(normalizeLocalPath(input), cwd);
      if (literal !== normalized && existsSync(literal)) return literal;
    } catch { /* malformed literal (e.g. bad file URL): use the normalized form */ }
  }
  return normalized;
}
