import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Interactive shortcut that moves running foreground commands/subagents to background jobs (unbound in Pi's default keymap). */
export const DETACH_SHORTCUT = "alt+j";
/** Last line of a running tool call the shortcut would move; the key is unbound by default, so the call itself says how. */
export const DETACH_HINT = "Alt+J: move running command/subagent to background";

type Entry = { detach: () => void };

// Shell and Subagents are separate extensions in one process: they share one registry and one shortcut registration.
const activeKey = Symbol.for("pi-better-tools.foreground-detach.active.v1");
const ownerKey = Symbol.for("pi-better-tools.foreground-detach.shortcut-owner.v1");
const rowsKey = Symbol.for("pi-better-tools.foreground-detach.rows.v1");
const root = globalThis as unknown as {
  [activeKey]?: Map<string, Entry>;
  [ownerKey]?: object;
  [rowsKey]?: Map<string, () => void>;
};
/** Tracked runs by the tool call that runs them; the id is what a rendered call can look itself up by. */
const active = (root[activeKey] ??= new Map<string, Entry>());
/** Last `invalidate` seen per rendered tool call, so starting or ending a run redraws its hint immediately. */
const rows = (root[rowsKey] ??= new Map<string, () => void>());
/** Rows are remembered per call for redraws only; bound it so long sessions cannot grow the map. */
const MAX_ROWS = 64;

const safe = (fn: () => void) => { try { fn(); } catch { /* UI hints are best effort */ } };

/**
 * Registers a running foreground command/dispatch under its tool call, so the shortcut can detach it and the call's own
 * render can show the hint. Returns the unregister function; call it once the work is settled or handed off.
 */
export function trackForeground(toolCallId: string, detach: () => void): () => void {
  active.set(toolCallId, { detach });
  safe(() => rows.get(toolCallId)?.());
  return () => {
    if (!active.delete(toolCallId)) return;
    safe(() => rows.get(toolCallId)?.());
  };
}

/** Whether this tool call currently runs foreground work that the shortcut would move. */
export const isForegroundDetachable = (toolCallId: string): boolean => active.has(toolCallId);

/** Remembers how to redraw a tool row; called by the row's own render on every pass. */
export function rememberToolRow(toolCallId: string, invalidate: () => void): void {
  rows.delete(toolCallId);
  rows.set(toolCallId, invalidate);
  if (rows.size > MAX_ROWS) {
    const oldest = rows.keys().next().value;
    if (oldest !== undefined) rows.delete(oldest);
  }
}

/** Drops the redraw handle once the call is finished; the hint is never shown again for it. */
export function forgetToolRow(toolCallId: string): void {
  rows.delete(toolCallId);
}

/** Detaches every running foreground command/dispatch; returns how many were asked to move. */
export function detachAllForeground(): number {
  const entries = [...active.values()];
  for (const entry of entries) safe(entry.detach);
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
  pi.on?.("input", (event, ctx) => {
    if (!shouldDetachOnInput(event, pi.getSettings?.()) || !hasForegroundWork()) return { action: "continue" as const };
    const count = detachAllForeground();
    if (count > 0) ctx.ui.notify(`Steer message sent: moving ${count} running foreground task(s) to background`, "info");
    return { action: "continue" as const };
  });
  pi.on?.("session_shutdown", () => { if (root[ownerKey] === pi) delete root[ownerKey]; });
}

const hasForegroundWork = () => active.size > 0;

/** `pi-shell-tools.detachOnSteer`: `false` disables; anything else keeps the default (on). */
export function resolveDetachOnSteer(settings: unknown): boolean {
  return (settings as { "pi-shell-tools"?: { detachOnSteer?: unknown } } | undefined)?.["pi-shell-tools"]?.detachOnSteer !== false;
}

/** Only a typed interactive steer message (not a follow-up, slash command or empty text) moves foreground work. */
export function shouldDetachOnInput(
  event: { text: string; source: string; streamingBehavior?: string },
  settings: unknown,
): boolean {
  return event.source === "interactive"
    && event.streamingBehavior === "steer"
    && event.text.trim() !== ""
    && !event.text.trimStart().startsWith("/")
    && resolveDetachOnSteer(settings);
}
