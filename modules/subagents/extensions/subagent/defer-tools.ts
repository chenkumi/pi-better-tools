import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Naming a deferred tool in `--tools` registers it but also activates it. When `tool_search` is active, undo that so the child loads
 * deferred tools on demand like the parent does; without `tool_search` they stay declared directly (the Pi Runtime fallback).
 * Reads the child's own registry, so the child's extension set decides which tools exist. */
export function deferActivatedTools(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">): void {
	const active = pi.getActiveTools();
	if (!active.includes("tool_search")) return;
	const deferred = new Set(pi.getAllTools().filter((tool) => tool.exposure === "deferred").map((tool) => tool.name));
	if (active.some((name) => deferred.has(name))) pi.setActiveTools(active.filter((name) => !deferred.has(name)));
}
