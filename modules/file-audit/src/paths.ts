import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedString } from "./activity-window.js";

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function safeRelative(value: unknown): value is string {
  return boundedString(value) && !isAbsolute(value) && !win32.isAbsolute(value) &&
    !value.includes("\\") && !value.includes(":") && value.split("/").every(x => x !== "" && x !== "." && x !== "..");
}
function localPath(raw: string): string {
  if (process.platform === "win32" && !raw.includes("\\")) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(raw);
    if (match) raw = `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return resolve(homedir(), raw.slice(2));
  return raw.startsWith("file://") ? fileURLToPath(raw) : raw;
}
export function resolveInput(raw: string, cwd: string): string {
  if (!boundedString(raw) || !boundedString(cwd)) throw new Error("invalid-path");
  const literal = resolve(cwd, localPath(raw));
  if ((raw.startsWith("@") || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(raw)) && existsSync(literal)) return literal;
  const normalized = (raw.startsWith("@") ? raw.slice(1) : raw).replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ");
  return resolve(cwd, localPath(normalized));
}
export function canonicalPath(raw: string, cwd: string): string {
  const root = realpathSync(cwd), path = realpathSync(resolveInput(raw, cwd));
  if (!boundedString(path) || !inside(root, path)) throw new Error("outside-workspace");
  return path;
}
export function credentialPath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some(part => {
    const name = part.toLowerCase();
    return name === ".env" || name.startsWith(".env.") || name === "auth.json" || name === ".git" || name === ".pi";
  });
}
export function notePath(result: unknown): string {
  const obj = asRecord(result);
  const values: string[] = [];
  for (const key of ["structuredContent", "details"]) {
    if (obj[key] === undefined) continue;
    const value = asRecord(obj[key]).relativePath;
    if (!safeRelative(value)) throw new Error("invalid-note-path");
    values.push(value);
  }
  if (!values.length || values.some(value => value !== values[0])) throw new Error("invalid-note-path");
  return values[0];
}
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
