import { createHash } from "node:crypto";
import { ulid } from "ulid";
import * as fs from "node:fs";
import * as path from "node:path";
import type { serializeToolResultContent } from "./subsession-log.ts";

export interface ToolSpoolRecord {
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: string;
	serialized: ReturnType<typeof serializeToolResultContent>;
}

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_JOURNAL_LINE_BYTES = 256;
const JOURNAL_CHUNK_BYTES = 4096;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** IDs (including the empty string) and anonymous content have disjoint namespaces. */
export function toolResultKey(record: ToolSpoolRecord): string {
	const hash = createHash("sha256");
	if (record.toolCallId !== undefined) {
		hash.update("id\0").update(record.toolCallId);
	} else {
		hash.update("content\0");
		// Fixed field order, independent of the caller's object property insertion order.
		for (const part of record.serialized.content) hash.update(JSON.stringify(["text", part.text]));
		hash.update("\0omitted\0");
		for (const part of record.serialized.omitted) {
			hash.update(JSON.stringify([part.role, part.contentType, part.mimeType, part.byteLength, part.path]));
		}
	}
	return hash.digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function sequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateRecord(value: unknown): asserts value is ToolSpoolRecord {
	let bytes = 0;
	const string = (entry: unknown): entry is string => {
		if (typeof entry !== "string") return false;
		bytes += Buffer.byteLength(entry, "utf8");
		return bytes <= MAX_RECORD_BYTES;
	};
	const optionalString = (entry: unknown) => entry === undefined || string(entry);
	if (!object(value) || !fields(value, ["toolCallId", "toolName", "isError", "serialized", "timestamp"])
		|| !optionalString(value.toolCallId) || !optionalString(value.toolName) || !optionalString(value.timestamp)
		|| (value.isError !== undefined && typeof value.isError !== "boolean")
		|| !object(value.serialized) || !fields(value.serialized, ["content", "omitted"])) {
		throw new Error("Invalid or oversized tool spool record");
	}
	const { content, omitted } = value.serialized;
	if (!Array.isArray(content) || !Array.isArray(omitted)
		|| content.length + omitted.length > MAX_RECORD_BYTES / 16) {
		throw new Error("Invalid or oversized tool spool content");
	}
	for (const part of content) {
		if (!object(part) || !fields(part, ["type", "text"]) || part.type !== "text" || !string(part.text)) {
			throw new Error("Invalid or oversized tool spool text");
		}
	}
	for (const part of omitted) {
		if (!object(part) || !fields(part, ["role", "contentType", "mimeType", "byteLength", "path"])
			|| part.role !== "toolResult" || !["image", "binary"].includes(part.contentType as string)
			|| !optionalString(part.mimeType) || !optionalString(part.path)
			|| (part.byteLength !== undefined && (typeof part.byteLength !== "number"
				|| !Number.isSafeInteger(part.byteLength) || part.byteLength < 0))) {
			throw new Error("Invalid or oversized tool spool omission");
		}
	}
}

function missing(error: unknown): boolean {
	return object(error) && error.code === "ENOENT";
}

interface JournalEntry {
	version: 1;
	sequence: number;
	key: string;
}

function validateEntry(value: unknown): asserts value is JournalEntry {
	if (!object(value) || value.version !== 1 || !sequence(value.sequence)
		|| typeof value.key !== "string" || !KEY_PATTERN.test(value.key)) {
		throw new Error("Invalid tool spool journal entry");
	}
}

/** Fixed-size reads also bound malformed/newline-free journals. No readline queue or file list. */
async function* journalEntries(filePath: string): AsyncGenerator<JournalEntry> {
	const handle = await fs.promises.open(filePath, "r");
	try {
		if (!(await handle.stat()).isFile()) throw new Error("Invalid tool spool journal file");
		const chunk = Buffer.alloc(JOURNAL_CHUNK_BYTES);
		const line = Buffer.alloc(MAX_JOURNAL_LINE_BYTES);
		let length = 0;
		let previous = 0;
		while (true) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			for (let offset = 0; offset < bytesRead; offset++) {
				if (chunk[offset] !== 10) {
					if (length === line.length) throw new Error("Oversized tool spool journal line");
					line[length++] = chunk[offset];
					continue;
				}
				const entry: unknown = JSON.parse(decoder.decode(line.subarray(0, length)));
				validateEntry(entry);
				if (!fields(entry as unknown as Record<string, unknown>, ["version", "sequence", "key"])
					|| entry.sequence <= previous) throw new Error("Invalid tool spool journal order");
				previous = entry.sequence;
				length = 0;
				yield entry;
			}
		}
		if (length !== 0) throw new Error("Truncated tool spool journal line");
	} finally {
		await handle.close();
	}
}

async function readRecord(filePath: string): Promise<unknown> {
	const handle = await fs.promises.open(filePath, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("Invalid or oversized tool spool file");
		// One extra byte detects growth after stat without allocating from an untrusted size.
		const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_RECORD_BYTES) throw new Error("Oversized tool spool file");
		return JSON.parse(decoder.decode(buffer.subarray(0, length)));
	} finally {
		await handle.close();
	}
}

/**
 * Caller owns serialization/backpressure; no pending promises, payload cache, or in-memory index.
 * Do not put while iterating. Removing the currently yielded record is supported. Always close an
 * abandoned iterator (for-await break does this), then call cleanup only when all I/O is settled
 * and the runner has safely persisted the results. Errors never trigger automatic deletion.
 * Disk writes are acknowledged, not fsynced; this is not a crash-recovery database.
 */
export class ToolResultSpool {
	readonly directory: string;
	private sequence = 0;
	private failure: string | undefined;
	private cleaned = false;
	private readers = 0;

	private constructor(directory: string) {
		this.directory = directory;
	}

	static async create(rootDir: string): Promise<ToolResultSpool> {
		await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
		const directory = await fs.promises.mkdtemp(path.join(path.resolve(rootDir), "tool-results-"));
		const spool = new ToolResultSpool(directory);
		try {
			await fs.promises.chmod(directory, 0o700);
			await fs.promises.writeFile(path.join(directory, "journal.jsonl"), "", { flag: "wx", mode: 0o600 });
			return spool;
		} catch (error) {
			throw spool.diagnostic("create", error);
		}
	}

	private diagnostic(operation: string, error: unknown): Error {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`Tool result spool ${operation} failed (${this.directory}); diagnostic files preserved: ${message}`, { cause: error });
	}

	private writable(): void {
		if (this.cleaned) throw new Error(`Tool result spool already cleaned: ${this.directory}`);
		if (this.failure) throw new Error(`Tool result spool is write-failed (${this.directory}): ${this.failure}`);
	}

	async put(record: ToolSpoolRecord): Promise<void> {
		this.writable();
		if (this.readers) throw new Error("Cannot put while tool spool iteration is active");
		try {
			validateRecord(record);
			if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Tool spool sequence exhausted");
			const entry: JournalEntry = { version: 1, sequence: ++this.sequence, key: toolResultKey(record) };
			const data = JSON.stringify({ ...entry, record });
			if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES) throw new Error("Oversized tool spool record");
			const temporary = path.join(this.directory, `${entry.key}.${entry.sequence}.${ulid().toLowerCase()}.partial`);
			await fs.promises.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
			// Journal first: an append failure leaves the old record AND the candidate intact.
			// A rename failure leaves a harmless unmatched version in the journal. No rollback
			// unlinks: partial writes and failed replacement candidates remain diagnostic artifacts.
			await fs.promises.appendFile(path.join(this.directory, "journal.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
			await fs.promises.rename(temporary, path.join(this.directory, `${entry.key}.json`));
		} catch (error) {
			this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
			throw this.diagnostic("put", error);
		}
	}

	async remove(record: ToolSpoolRecord): Promise<void> {
		this.writable();
		try {
			validateRecord(record);
			// Absence is the on-disk tombstone. Old journal entries cannot resurrect it;
			// a later put has a new sequence, so only its new journal entry will match.
			try {
				await fs.promises.unlink(path.join(this.directory, `${toolResultKey(record)}.json`));
			} catch (error) {
				if (!missing(error)) throw error;
			}
		} catch (error) {
			this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
			throw this.diagnostic("remove", error);
		}
	}

	async *records(): AsyncGenerator<ToolSpoolRecord> {
		if (this.cleaned) throw new Error(`Tool result spool already cleaned: ${this.directory}`);
		this.readers++;
		try {
			for await (const entry of journalEntries(path.join(this.directory, "journal.jsonl"))) {
				if (entry.sequence > this.sequence) throw new Error("Unknown tool spool journal sequence");
				let stored: unknown;
				try {
					stored = await readRecord(path.join(this.directory, `${entry.key}.json`));
				} catch (error) {
					if (missing(error)) continue;
					throw error;
				}
				validateEntry(stored);
				const envelope = stored as unknown as Record<string, unknown>;
				if (!fields(envelope, ["version", "sequence", "key", "record"]) || stored.key !== entry.key
					|| stored.sequence > this.sequence) throw new Error("Invalid tool spool record envelope");
				validateRecord(envelope.record);
				if (toolResultKey(envelope.record) !== entry.key) throw new Error("Tool spool record key mismatch");
				if (stored.sequence === entry.sequence) yield envelope.record;
			}
		} catch (error) {
			throw this.diagnostic("read", error);
		} finally {
			this.readers--;
		}
	}

	async cleanup(): Promise<void> {
		if (this.cleaned) return;
		if (this.readers) throw new Error("Close tool spool iterators before cleanup");
		try {
			// Stream even cleanup's directory entries; recursive rm can materialize a file list.
			let directory: fs.Dir;
			try {
				directory = await fs.promises.opendir(this.directory, { bufferSize: 32 });
			} catch (error) {
				if (!missing(error)) throw error;
				this.cleaned = true;
				return;
			}
			for await (const entry of directory) await fs.promises.unlink(path.join(this.directory, entry.name));
			await fs.promises.rmdir(this.directory);
			this.cleaned = true;
		} catch (error) {
			throw this.diagnostic("cleanup", error);
		}
	}
}
