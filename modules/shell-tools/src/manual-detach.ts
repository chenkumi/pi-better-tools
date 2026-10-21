import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Interactive shortcut that moves running foreground commands/subagents to background jobs (unbound in Pi's default keymap). */
export const DETACH_SHORTCUT = "alt+j";
const STATUS_KEY = "foreground-detach";

type Ui = ExtensionContext["ui"];
type Entry = { detach: () => void; ui: Ui };

// Shell and Subagents are separate extensions in one process: they share one registry and one shortcut registration.
const activeKey = Symbol.for("pi-better-tools.foreground-detach.active.v1");
const ownerKey = Symbol.for("pi-better-tools.foreground-detach.shortcut-owner.v1");
const root = globalThis as typeof globalThis & { [activeKey]?: Map<symbol, Entry>; [ownerKey]?: object };
const active = (root[activeKey] ??= new Map<symbol, Entry>());

const safe = (fn: () => void) => { try { fn(); } catch { /* UI hints are best effort */ } };

/**
 * Registers a running foreground command/dispatch so the shortcut can detach it, and shows a status hint while any
 * is running. Returns the unregister function; call it once the work is settled or handed off.
 */
export function trackForeground(ui: Ui, detach: () => void): () => void {
  const id = Symbol("foreground");
  active.set(id, { detach, ui });
  safe(() => ui.setStatus(STATUS_KEY, "Alt+J: move running command/subagent to background"));
  return () => {
    if (!active.delete(id)) return;
    if (active.size === 0) safe(() => ui.setStatus(STATUS_KEY, undefined));
  };
}

/** Detaches every running foreground command/dispatch; returns how many were asked to move. */
export function detachAllForeground(): number {
  const entries = [...active.values()];
  for (const entry of entries) entry.detach();
  return entries.length;
}

/**
 * Registers the shortcut once per live runtime, whichever extension loads first. The owner releases the claim on
 * session shutdown so a reload registers again.
 */
export function ensureDetachShortcut(pi: ExtensionAPI): void {
  if (root[ownerKey] || typeof pi.registerShortcut !== "function") return;
  root[ownerKey] = pi;
  pi.registerShortcut(DETACH_SHORTCUT, {
    description: "Move running foreground shell commands and subagents to background jobs",
    handler: ctx => {
      const count = detachAllForeground();
      ctx.ui.notify(count > 0 ? `Moving ${count} running foreground task(s) to background` : "No running foreground shell command or subagent", "info");
    },
  });
  pi.on?.("session_shutdown", () => { if (root[ownerKey] === pi) delete root[ownerKey]; });
}
