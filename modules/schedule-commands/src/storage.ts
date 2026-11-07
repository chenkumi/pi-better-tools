/**
 * Job store: `<cwd>/.pi/schedule-commands.json` (version 2). Atomic writes, a cross-process directory lock around
 * read-modify-write, and a rule that unreadable data is never replaced by an empty store.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import { parseStore, ValidationError } from "./validate.ts";
import type { Job, StoreFile } from "./types.ts";

export const STORE_NAME = "schedule-commands.json";
export const LEGACY_STORE_NAME = "schedule-prompts.json";
const STALE_LOCK_MS = 30_000;

export class StoreLockUnavailable extends Error {}
export class StoreUnreadable extends Error {}

export const newJobId = (): string => ulid().toUpperCase();

function lockWaitMs(): number {
	const raw = Number(process.env.PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS);
	return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60_000) : 2000;
}
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface LoadResult {
	store: StoreFile;
	dropped: Array<{ index: number; reason: string }>;
	/** Set when an unusable file was moved aside and replaced by an empty store; the path of the kept copy. */
	quarantined?: string;
}

export class ScheduleStore {
	readonly file: string;
	readonly legacyFile: string;
	readonly #lock: string;

	constructor(cwd: string) {
		const dir = join(cwd, ".pi");
		this.file = join(dir, STORE_NAME);
		this.legacyFile = join(dir, LEGACY_STORE_NAME);
		this.#lock = join(dir, "schedule-commands.lock");
	}

	/** The old Schedule Prompt file is never read, converted or deleted; callers only tell the user once. */
	hasLegacyFile(): boolean { return existsSync(this.legacyFile); }

	/** Read without locking. Only a missing file is an empty store; any other read failure throws. */
	read(): LoadResult {
		let raw: string;
		try { raw = readFileSync(this.file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: { version: 2, jobs: [] }, dropped: [] };
			throw new StoreUnreadable(`cannot read the schedule store: ${(error as Error).message}`);
		}
		try { return { ...parseStore(JSON.parse(raw)) }; }
		catch (error) {
			if (!(error instanceof ValidationError) && !(error instanceof SyntaxError)) throw error;
			const quarantined = `${this.file}.corrupt-${Date.now()}`;
			renameSync(this.file, quarantined);
			return { store: { version: 2, jobs: [] }, dropped: [], quarantined };
		}
	}

	#acquire(): void {
		mkdirSync(dirname(this.#lock), { recursive: true });
		const deadline = Date.now() + lockWaitMs();
		for (;;) {
			try { mkdirSync(this.#lock); return; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					if (Date.now() - statSync(this.#lock).mtimeMs > STALE_LOCK_MS) { rmSync(this.#lock, { recursive: true, force: true }); continue; }
				} catch { continue; }
				if (Date.now() >= deadline) throw new StoreLockUnavailable("the schedule store is locked by another process; try again");
				sleepSync(25);
			}
		}
	}

	/** Locked read-modify-write. `change` returns the new job list, or no list to leave the file untouched. */
	update<T>(change: (jobs: Job[]) => { jobs?: Job[]; result: T }): T {
		this.#acquire();
		try {
			const loaded = this.read();
			const outcome = change(loaded.store.jobs);
			if (outcome.jobs) {
				if (loaded.dropped.length && existsSync(this.file)) copyFileSync(this.file, `${this.file}.invalid-${Date.now()}`);
				const tmp = `${this.file}.${process.pid}.tmp`;
				writeFileSync(tmp, `${JSON.stringify({ version: 2, jobs: outcome.jobs }, null, 2)}\n`);
				renameSync(tmp, this.file);
			}
			return outcome.result;
		} finally {
			rmSync(this.#lock, { recursive: true, force: true });
		}
	}
}
