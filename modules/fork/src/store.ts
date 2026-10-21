import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForkUsage } from "./child.ts";
import type { TranscriptInfo } from "./transcript.ts";

export type ForkStatus = "awaiting_snapshot" | "starting" | "running" | "blocked" | "finalizing" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export type Delivery = "pending" | "submitted" | "observed" | "unknown" | "not_required";
export const ACTIVE_STATUSES: readonly ForkStatus[] = ["awaiting_snapshot", "starting", "running", "blocked", "finalizing", "cancelling"];
export const isTerminal = (status: ForkStatus) => !ACTIVE_STATUSES.includes(status);
export const MAX_RESULT_BYTES = 32 * 1024;
export const MAX_STORED = 64;

/** Plain, secret-free metadata. The task text is kept only as a bounded preview; credentials never enter this file. */
export interface ForkRecord {
	schemaVersion: 1;
	jobId: string;
	forkSessionId: string;
	title: string;
	taskPreview: string;
	status: ForkStatus;
	cancelRequested: boolean;
	origin: { sessionId: string; file?: string; cwd: string };
	config: { model: string; thinkingLevel: string; trusted: boolean; toolsFingerprint: string; toolCount: number };
	sessionPath?: string;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	ownerPid: number;
	result?: { resultId: string; output?: string; outputTruncated?: boolean; errorCode?: string; error?: string; usage?: ForkUsage; usageUnknown?: boolean };
	cleanup?: { childClosed: boolean; exitCode?: number | null };
	/** Query-only log of this Fork's own conversation (post-start messages only). Auxiliary: `unavailable` never fails the Fork. */
	transcript?: TranscriptInfo;
	/** Non-terminal truth: the child's own model call failed while nested jobs are still unfinished, so the
	 *  Fork cannot make progress on its own. Reported by the child guard, never inferred by the parent. */
	blocked?: { reason: string; error?: string; pending: { shell: number; subagents: number }; since: string };
	delivery: Delivery;
}

export const forksDir = (cwd: string) => join(cwd, ".pi", "forks");
export const recordPath = (cwd: string, jobId: string) => join(forksDir(cwd), `${jobId}.json`);
/** Per-Fork directory holding `transcript.jsonl`; removed together with the record when it is pruned. */
export const transcriptDir = (cwd: string, jobId: string) => join(forksDir(cwd), jobId);

/** Atomic replace (temp + rename), owner-only. Throws on failure so callers can mark persistence trouble. */
export function saveRecord(cwd: string, record: ForkRecord): void {
	const dir = forksDir(cwd);
	mkdirSync(dir, { recursive: true });
	const final = recordPath(cwd, record.jobId), temp = `${final}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
	try { chmodSync(temp, 0o600); } catch { /* not supported on every platform */ }
	// Windows refuses to replace a file another process currently has open (EPERM/EBUSY/EACCES); readers are short-lived, so retry briefly.
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; ; attempt++) {
		try { renameSync(temp, final); return; }
		catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (attempt < 12 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) { Atomics.wait(pause, 0, 0, 10 * (attempt + 1)); continue; }
			try { rmSync(temp, { force: true }); } catch { /* best effort */ }
			throw error;
		}
	}
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUSES = new Set<string>(["awaiting_snapshot", "starting", "running", "blocked", "finalizing", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
const DELIVERIES = new Set<string>(["pending", "submitted", "observed", "unknown", "not_required"]);
export function parseRecord(text: string): ForkRecord | undefined {
	try {
		const value = JSON.parse(text);
		if (!value || value.schemaVersion !== 1 || !ULID.test(value.jobId) || typeof value.forkSessionId !== "string" || !STATUSES.has(value.status) || !DELIVERIES.has(value.delivery)) return undefined;
		if (typeof value.origin?.sessionId !== "string" || typeof value.origin?.cwd !== "string" || typeof value.createdAt !== "string" || typeof value.ownerPid !== "number") return undefined;
		return value as ForkRecord;
	} catch { return undefined; }
}

const recordNames = (cwd: string) => readdirSync(forksDir(cwd)).filter(name => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(name)).sort().reverse();

/** Bounded newest-first scan; unreadable or foreign files are skipped, never repaired or deleted. */
export function loadRecords(cwd: string, limit = MAX_STORED): ForkRecord[] {
	let names: string[];
	try { names = recordNames(cwd).slice(0, limit); } catch { return []; }
	const records: ForkRecord[] = [];
	for (const name of names) {
		try { const record = parseRecord(readFileSync(join(forksDir(cwd), name), "utf8")); if (record && `${record.jobId}.json` === name) records.push(record); } catch { /* skip */ }
	}
	return records;
}

/** Best effort: deletes records the bounded scan can no longer see, but only finished ones whose result needs no delivery.
 *  Unfinished, undelivered, unreadable or foreign files are kept. Returns the number removed. */
export function pruneRecords(cwd: string, keep = MAX_STORED, maxDeletes = MAX_STORED): number {
	let removed = 0;
	let names: string[];
	try { names = recordNames(cwd).slice(keep); } catch { return 0; }
	for (const name of names) {
		if (removed >= maxDeletes) break;
		try {
			const path = join(forksDir(cwd), name), record = parseRecord(readFileSync(path, "utf8"));
			if (!record || `${record.jobId}.json` !== name || !isTerminal(record.status) || record.delivery === "pending") continue;
			rmSync(path, { force: true });
			try { rmSync(transcriptDir(cwd, record.jobId), { recursive: true, force: true }); } catch { /* the record is already gone; a leftover transcript is harmless */ }
			removed++;
		} catch { /* keep it */ }
	}
	return removed;
}
