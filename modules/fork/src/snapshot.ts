import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { FORK_MARKER_TYPE } from "./identity.ts";

type Entry = Record<string, any>;
export interface SnapshotSource {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	sessionDir: string;
	/** Root→leaf active branch (SessionManager.getBranch). */
	branch: readonly Entry[];
}
export interface ForkMarkerData { role: "fork"; forkId: string; parentSessionId: string; parentSessionFile?: string; createdAt: string }

/** A tool call whose result is not yet canonical must never be copied; results are not fabricated. */
export function unpairedToolCalls(branch: readonly Entry[]): string[] {
	const calls = new Set<string>(), results = new Set<string>();
	for (const entry of branch) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content) if (block?.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
		if (message.role === "toolResult" && typeof message.toolCallId === "string") results.add(message.toolCallId);
	}
	return [...calls].filter(id => !results.has(id));
}

function shortId(used: Set<string>) {
	for (let i = 0; i < 100; i++) { const id = randomUUID().slice(0, 8); if (!used.has(id)) return id; }
	return randomUUID();
}

/** Writes one new authoritative native JSONL (wx, 0600) holding the exact active-branch entries plus an origin marker.
 *  The source manager is only read: its leaf and file are untouched. */
export function writeForkSession(source: SnapshotSource, forkId: string, sessionId: string, now = new Date()): { sessionId: string; sessionPath: string; leafId: string; entryCount: number } {
	const unpaired = unpairedToolCalls(source.branch);
	if (unpaired.length) throw new Error(`SNAPSHOT_UNPAIRED_TOOL_CALLS: ${unpaired.length} tool call(s) have no canonical result yet.`);
	const timestamp = now.toISOString();
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: source.cwd, ...(source.sessionFile ? { parentSession: source.sessionFile } : {}) };
	const used = new Set(source.branch.map(entry => String(entry.id)));
	const leaf = source.branch.at(-1)?.id ?? null;
	const marker: Entry = { type: "custom", customType: FORK_MARKER_TYPE, data: { role: "fork", forkId, parentSessionId: source.sessionId, ...(source.sessionFile ? { parentSessionFile: source.sessionFile } : {}), createdAt: timestamp } satisfies ForkMarkerData,
		id: shortId(used), parentId: leaf, timestamp };
	const lines = [header, ...source.branch, marker].map(entry => JSON.stringify(entry)).join("\n") + "\n";
	mkdirSync(source.sessionDir, { recursive: true });
	const sessionPath = join(source.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	const fd = openSync(sessionPath, "wx", 0o600);
	try { writeSync(fd, lines); fsyncSync(fd); } finally { closeSync(fd); }
	return { sessionId, sessionPath, leafId: marker.id, entryCount: source.branch.length + 1 };
}
