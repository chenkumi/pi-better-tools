/**
 * Project-layer admission shared by runtime config, config manager and settings UI.
 *
 * Pi's SettingsManager skips project settings when the cwd is untrusted. Blackhole reads
 * `<cwd>/.pi/*` itself, so it must follow the same decision. The decision is recorded from a
 * fresh host context (`ctx.isProjectTrusted()`) and consulted by every project-layer read.
 * Unknown (never recorded, missing/throwing/non-boolean host answer) is NOT trusted.
 */
import { resolve } from "node:path";

const decisions = new Map<string, boolean>();

const key = (cwd: string): string => {
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/** Read the host's trust answer; anything other than a literal `true` is not trusted. */
export function hostProjectTrust(ctx: unknown): boolean {
  try {
    const fn = (ctx as { isProjectTrusted?: unknown } | undefined)?.isProjectTrusted;
    return typeof fn === "function" ? (fn as () => unknown).call(ctx) === true : false;
  } catch {
    return false;
  }
}

/** Record the decision for a cwd. Call at session_start/session_tree and command entry. */
export function recordProjectTrust(cwd: string | undefined, ctx: unknown): boolean {
  const trusted = hostProjectTrust(ctx);
  if (cwd) decisions.set(key(cwd), trusted);
  return trusted;
}

/** True only when a fresh host context recorded trust for this cwd. */
export function isProjectLayerAdmitted(cwd: string | undefined): boolean {
  return !!cwd && decisions.get(key(cwd)) === true;
}

/** Test seam: forget decisions (or set one explicitly). */
export function setProjectTrustForTests(cwd: string, trusted: boolean | undefined): void {
  if (trusted === undefined) decisions.delete(key(cwd));
  else decisions.set(key(cwd), trusted);
}
