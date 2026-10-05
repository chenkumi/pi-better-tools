import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { StringDecoder } from "node:string_decoder";
import type { AgentConfig, AgentScope } from "./agents.ts";
import type { SessionPersistence } from "./child-args.ts";

export const MAX_METADATA_BYTES = 256 * 1024;
export const MAX_NATIVE_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_BYTES = 128 * 1024 * 1024;
export const MAX_SESSION_DISK_BYTES = 512 * 1024 * 1024;
export const MAX_SESSION_FILES = 10_000;
const MAX_NATIVE_ENTRIES = 16_384;
// New IDs are lowercase ULIDs; legacy lowercase UUIDs stay valid so existing sessions can resume.
const SESSION_ID = /^(?:[0-9a-hjkmnp-tv-z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export type SessionState = "new" | "running" | "committing" | "ready" | "blocked";
export class SessionError extends Error {
	readonly code: string;
	constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}
export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export interface SessionOwner { parentSessionId: string; parentCwd: string }
export interface SavedConfig {
	agent: AgentConfig;
	agentScope: AgentScope;
	agentFingerprint: string;
	sourceSha256: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	projectTrusted: boolean;
	/** Actual child resource trust; observed by its startup guard, not inherited from parent. */
	childTrusted?: boolean;
	toolPolicy: "allowlist" | "child-defaults";
}
export interface Checkpoint {
	nativeSha256: string;
	nativeBytes: number;
	readableCommittedBytes: number;
	completedTaskId: string;
	leafId: string;
}
export interface SessionManifest {
	version: 1;
	transcriptVersion: 2;
	hostContract: "0.99.1";
	id: string;
	owner: SessionOwner;
	config: SavedConfig;
	state: SessionState;
	createdAt: string;
	updatedAt: string;
	nativeFile?: string;
	checkpoint?: Checkpoint;
	lastRun?: string;
	errorCode?: string;
}
interface WriterLock { nonce: string; taskId: string; pid: number; createdAt: string }
interface RunIntent {
	version: 1; taskId: string; dispatchKey: string; requestHash: string; oldCommittedBytes: number;
	state: string; startedAt: string; ownerNonce: string; [key: string]: unknown;
}
function fail(code: string, message: string): never { throw new SessionError(code, message); }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const validHash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export async function canonicalCwd(cwd: string): Promise<string> {
	try {
		const real = await fs.promises.realpath(cwd);
		if (!(await fs.promises.stat(real)).isDirectory()) fail("CWD_UNAVAILABLE", cwd);
		return real;
	} catch (e) { if (e instanceof SessionError) throw e; return fail("CWD_UNAVAILABLE", cwd); }
}
export function agentFingerprint(agent: AgentConfig): string { return sha256(JSON.stringify(agent)); }
export async function snapshotConfig(agent: AgentConfig, agentScope: AgentScope, cwd: string, model: string | undefined, thinkingLevel: string | undefined, projectTrusted: boolean): Promise<SavedConfig> {
	const source = await readBounded(agent.filePath);
	return { agent: { ...agent, ...(agent.tools ? { tools: [...agent.tools] } : {}) }, agentScope,
		agentFingerprint: agentFingerprint(agent), sourceSha256: sha256(source), cwd: await canonicalCwd(cwd), model, thinkingLevel,
		projectTrusted, toolPolicy: agent.tools?.length ? "allowlist" : "child-defaults" };
}
export async function validateConfig(config: SavedConfig, agent: AgentConfig | undefined, projectTrusted: boolean): Promise<void> {
	if (!agent || agentFingerprint(agent) !== config.agentFingerprint) fail("CONFIG_CHANGED", "Agent definition changed or disappeared");
	let source: string;
	try { source = await readBounded(agent.filePath); } catch { return fail("CONFIG_CHANGED", "Agent source unavailable"); }
	if (sha256(source) !== config.sourceSha256) fail("CONFIG_CHANGED", "Agent source bytes changed");
	if (await canonicalCwd(config.cwd) !== config.cwd) fail("CWD_UNAVAILABLE", "Child cwd identity changed");
	if (config.projectTrusted !== projectTrusted || (agent.source === "project" && !projectTrusted)) fail("TRUST_REQUIRED", "Current project trust does not match saved configuration");
}
async function readBounded(file: string): Promise<string> {
	const handle = await fs.promises.open(file, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_METADATA_BYTES) fail("METADATA_UNSUPPORTED", "Metadata/source must be a regular file <=256 KiB");
		const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1); let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_METADATA_BYTES) fail("METADATA_UNSUPPORTED", "Metadata grew beyond limit");
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally { await handle.close(); }
}
async function readJson(file: string): Promise<any> { return JSON.parse(await readBounded(file)); }
async function atomicJson(file: string, value: unknown, active: () => boolean = () => true): Promise<void> {
	const text = JSON.stringify(value, null, 2) + "\n";
	if (Buffer.byteLength(text) > MAX_METADATA_BYTES) fail("METADATA_UNSUPPORTED", "Serialized metadata exceeds capacity");
	const temp = `${file}.${ulid().toLowerCase()}.partial`;
	const handle = await fs.promises.open(temp, "wx", 0o600);
	try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
	if (!active()) fail("COMMIT_FAILED", "I/O deadline elapsed before metadata publish");
	await renameWithRetry(temp, file);
}
/** Windows can transiently deny rename (AV scanners, indexers, concurrent readers) with EPERM/EBUSY/EACCES. */
export async function renameWithRetry(from: string, to: string, attempts = 6, platform: NodeJS.Platform = process.platform, rename: (from: string, to: string) => Promise<void> = fs.promises.rename): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try { await rename(from, to); return; }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// The partial file is deliberately kept as failure evidence.
			if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt + 1 >= attempts) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
}
function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/** Existing managed paths may not contain symlinks/junctions, even if they point inside. */
async function contained(root: string, target: string): Promise<void> {
	const rel = path.relative(root, target);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail("CHECKPOINT_MISMATCH", "Managed path escapes root");
	let cursor = root;
	for (const component of rel.split(path.sep)) {
		cursor = path.join(cursor, component);
		const st = await fs.promises.lstat(cursor);
		if (st.isSymbolicLink()) fail("CHECKPOINT_MISMATCH", "Managed symlink/junction rejected");
	}
	const real = await fs.promises.realpath(target);
	if (path.relative(root, real) !== rel) fail("CHECKPOINT_MISMATCH", "Managed real path identity changed");
}
function validateManifest(m: unknown, id: string): asserts m is SessionManifest {
	if (!record(m) || m.version !== 1 || m.transcriptVersion !== 2 || m.hostContract !== "0.99.1") fail("METADATA_UNSUPPORTED", "Unsupported manifest contract");
	if (m.id !== id || !record(m.owner) || typeof m.owner.parentSessionId !== "string" || typeof m.owner.parentCwd !== "string" || !path.isAbsolute(m.owner.parentCwd)) fail("METADATA_UNSUPPORTED", "Invalid owner/identity");
	const c = m.config;
	if (!record(c) || !record(c.agent) || !["bundled", "user", "project"].includes(c.agent.source) || typeof c.agent.name !== "string" || typeof c.agent.systemPrompt !== "string" || typeof c.agent.filePath !== "string" || !["user", "project", "both"].includes(c.agentScope) || !validHash(c.agentFingerprint) || !validHash(c.sourceSha256) || typeof c.cwd !== "string" || !path.isAbsolute(c.cwd) || typeof c.projectTrusted !== "boolean" || !["allowlist", "child-defaults"].includes(c.toolPolicy) || (c.childTrusted !== undefined && typeof c.childTrusted !== "boolean") || (c.model !== undefined && typeof c.model !== "string") || (c.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(c.thinkingLevel))) fail("METADATA_UNSUPPORTED", "Invalid saved configuration");
	if (!["new", "running", "committing", "ready", "blocked"].includes(m.state)) fail("METADATA_UNSUPPORTED", "Invalid session state");
	if (m.state === "ready") {
		const cp = m.checkpoint;
		if (!record(cp) || !validHash(cp.nativeSha256) || !integer(cp.nativeBytes) || !integer(cp.readableCommittedBytes) || typeof cp.leafId !== "string" || !SESSION_ID.test(cp.completedTaskId) || !c.model || !c.thinkingLevel || typeof c.childTrusted !== "boolean" || typeof m.nativeFile !== "string" || !/^pi\/[\w.\-]+\.jsonl$/.test(m.nativeFile)) fail("METADATA_UNSUPPORTED", "Invalid ready checkpoint");
	}
}

/** Digest only canonical new conversation messages, not usage, diagnostics, or history. */
export class ConversationDigest {
	private hash = createHash("sha256");
	count = 0;
	users = 0;
	add(message: Record<string, any>): void {
		if (!["user", "assistant", "toolResult"].includes(message.role)) return;
		const value = { role: message.role, content: message.content, ...(message.role === "assistant" ? { stopReason: message.stopReason } : {}),
			...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}) };
		this.hash.update(JSON.stringify(value) + "\n"); this.count++;
		if (message.role === "user") this.users++;
	}
	value(): string { return this.hash.copy().digest("hex"); }
}
interface NativeInspection { hash: string; prefixHash: string; prefixLeaf: string; bytes: number; leafId: string; digest: ConversationDigest; model?: string; thinkingLevel?: string }
/** Streaming, readonly, linear-branch validation. Never open a writable SessionManager. */
async function inspectNative(file: string, id: string, cwd: string, since: number): Promise<NativeInspection> {
	const st = await fs.promises.stat(file);
	if (!st.isFile() || st.size > MAX_NATIVE_BYTES) fail("SESSION_BLOCKED", "Native session exceeds 128 MiB policy");
	const prefix = createHash("sha256"), hash = createHash("sha256"), digest = new ConversationDigest(), decoder = new StringDecoder("utf8");
	let buffer = "", bytes = 0, offset = 0, entries = 0, leafId = "", model: string | undefined, thinkingLevel: string | undefined;
	let lastRole = "", lastStop = "", sawHeader = false, prefixLeaf = "", boundary = since === 0;
	const ids = new Set<string>(), pending = new Set<string>();
	const line = (text: string) => {
		const start = offset; offset += Buffer.byteLength(text, "utf8") + 1;
		if (Buffer.byteLength(text) > MAX_NATIVE_RECORD_BYTES) fail("CHECKPOINT_MISMATCH", "Oversized native record");
		let e: any; try { e = JSON.parse(text); } catch { return fail("CHECKPOINT_MISMATCH", "Malformed native JSONL"); }
		if (!record(e)) fail("CHECKPOINT_MISMATCH", "Invalid native entry");
		if (!sawHeader) {
			sawHeader = true;
			if (e.type !== "session" || e.version !== 3 || e.id !== id || e.cwd !== cwd || e.parentSession !== undefined) fail("CHECKPOINT_MISMATCH", "Native header identity/version/cwd mismatch");
			return;
		}
		if (++entries > MAX_NATIVE_ENTRIES || typeof e.id !== "string" || e.id.length > 128 || ids.has(e.id) || e.parentId !== (leafId || null)) fail("CHECKPOINT_MISMATCH", "Invalid/branched native tree or entry capacity exceeded");
		ids.add(e.id); leafId = e.id;
		if (offset === since) { prefixLeaf = leafId; boundary = true; }
		if (e.type === "model_change") {
			if (typeof e.provider !== "string" || typeof e.modelId !== "string") fail("CHECKPOINT_MISMATCH", "Invalid native model selection");
			model = `${e.provider}/${e.modelId}`;
		}
		if (e.type === "thinking_level_change") thinkingLevel = e.thinkingLevel;
		if (e.type !== "message" || !record(e.message)) return;
		const m = e.message;
		if (m.role === "assistant") {
			if (!Array.isArray(m.content)) fail("CHECKPOINT_MISMATCH", "Invalid native assistant");
			for (const p of m.content) if (p.type === "toolCall") {
				if (typeof p.id !== "string" || p.id.length > 1024 || pending.has(p.id) || pending.size >= 1024) fail("CHECKPOINT_MISMATCH", "Invalid pending native tool call");
				pending.add(p.id);
			}
			lastRole = m.role; lastStop = m.stopReason;
		} else if (m.role === "toolResult") {
			if (!pending.delete(m.toolCallId)) fail("CHECKPOINT_MISMATCH", "Unpaired native tool result");
			lastRole = m.role;
		} else if (m.role === "user") lastRole = m.role;
		if (start >= since) digest.add(m);
	};
	const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
	try {
		for await (const chunk of stream) {
			if (bytes < since) prefix.update(chunk.subarray(0, Math.min(chunk.length, since - bytes)));
			bytes += chunk.length;
			if (bytes > MAX_NATIVE_BYTES) fail("SESSION_BLOCKED", "Native file grew beyond limit");
			hash.update(chunk); buffer += decoder.write(chunk);
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
			if (Buffer.byteLength(buffer) > MAX_NATIVE_RECORD_BYTES) fail("CHECKPOINT_MISMATCH", "Native record exceeds limit");
		}
		buffer += decoder.end();
		if (buffer || !boundary || !sawHeader || bytes !== st.size || since > bytes || !["stop", "length"].includes(lastStop) || lastRole !== "assistant" || pending.size) fail("CHECKPOINT_MISMATCH", "Native session incomplete or changed during inspection");
		return { hash: hash.digest("hex"), prefixHash: prefix.digest("hex"), prefixLeaf, bytes, leafId, digest, model, thinkingLevel };
	} finally { stream.destroy(); }
}

export class ManagedSession {
	private lock?: WriterLock;
	private run?: RunIntent;
	readonly root: string;
	readonly directory: string;
	manifest: SessionManifest;
	private constructor(root: string, directory: string, manifest: SessionManifest) { this.root = root; this.directory = directory; this.manifest = manifest; }
	get id() { return this.manifest.id; }
	get logPath() { return path.join(this.directory, "transcript.jsonl"); }
	get runDir() { if (!this.run) return fail("COMMIT_FAILED", "No active run"); return path.join(this.directory, "runs", this.run.taskId); }
	get persistence(): SessionPersistence {
		return this.manifest.nativeFile ? { kind: "resume", sessionDir: path.join(this.directory, "pi"), sessionFile: path.join(this.directory, this.manifest.nativeFile) }
			: { kind: "new", sessionDir: path.join(this.directory, "pi"), sessionId: this.id };
	}
	static async allocate(root: string, owner: SessionOwner, config: SavedConfig): Promise<ManagedSession> {
		await fs.promises.mkdir(root, { recursive: true, mode: 0o700 }); root = await fs.promises.realpath(root);
		const id = ulid().toLowerCase(), directory = path.join(root, id), timestamp = new Date().toISOString();
		await fs.promises.mkdir(directory, { mode: 0o700 });
		await fs.promises.mkdir(path.join(directory, "pi"), { mode: 0o700 });
		await fs.promises.mkdir(path.join(directory, "runs"), { mode: 0o700 });
		await fs.promises.mkdir(path.join(directory, "dispatch"), { mode: 0o700 });
		const manifest: SessionManifest = { version: 1, transcriptVersion: 2, hostContract: "0.99.1", id, owner, config, state: "new", createdAt: timestamp, updatedAt: timestamp };
		await atomicJson(path.join(directory, "manifest.json"), manifest);
		return new ManagedSession(root, directory, manifest);
	}
	static async resolve(root: string, id: string, owner: SessionOwner): Promise<ManagedSession> {
		if (!SESSION_ID.test(id)) fail("INVALID_DISPATCH", "resume requires a complete lowercase session ID (ULID or legacy UUID), not a path or partial ID");
		try { root = await fs.promises.realpath(root); } catch { return fail("SESSION_NOT_FOUND", id); }
		const directory = path.join(root, id);
		let m: unknown;
		try { await contained(root, path.join(directory, "manifest.json")); m = await readJson(path.join(directory, "manifest.json")); }
		catch (e) { if (e instanceof SessionError) throw e; if ((e as any).code === "ENOENT") return fail("SESSION_NOT_FOUND", id); return fail("METADATA_UNSUPPORTED", "Cannot read manifest"); }
		validateManifest(m, id);
		if (m.owner.parentSessionId !== owner.parentSessionId || m.owner.parentCwd !== owner.parentCwd) fail("OWNER_MISMATCH", "Continuation belongs to a different parent session/cwd");
		return new ManagedSession(root, directory, m);
	}
	/** A lock is stale only when its recorded owner pid (another process) is provably gone. */
	private async lockIsStale(): Promise<boolean> {
		try {
			const file = path.join(this.directory, "writer.lock", "owner.json");
			await contained(this.root, file);
			const owner = await readJson(file);
			return record(owner) && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid && !pidAlive(owner.pid);
		} catch { return false; }
	}
	async assertResumable(): Promise<void> {
		try { await fs.promises.lstat(path.join(this.directory, "writer.lock")); }
		catch (error) {
			if ((error as any).code !== "ENOENT") throw error;
			if (this.manifest.state !== "ready") fail("SESSION_BLOCKED", `Session state is ${this.manifest.state}; manual inspection required`);
			return;
		}
		if (await this.lockIsStale()) {
			// acquire() takes over and rolls back to the verified checkpoint, or refuses.
			if (!this.manifest.checkpoint) fail("SESSION_BLOCKED", "Stale writer lock without a verified checkpoint; manual inspection required");
			return;
		}
		fail("SESSION_BUSY", "Writer lock exists; no automatic takeover");
	}
	async acquire(taskId: string): Promise<void> {
		if (!SESSION_ID.test(taskId)) fail("INVALID_DISPATCH", "Invalid internal task ID");
		await contained(this.root, this.directory);
		const lockDir = path.join(this.directory, "writer.lock");
		let recovered = false;
		for (let attempt = 0; ; attempt++) {
			try { await fs.promises.mkdir(lockDir, { mode: 0o700 }); break; }
			catch (e) {
				if ((e as any).code !== "EEXIST") throw e;
				if (attempt > 0 || !(await this.lockIsStale())) return fail("SESSION_BUSY", "Writer lock exists; no automatic takeover");
				// Atomic rename elects a single winner when several processes find the same dead owner.
				const stale = `${lockDir}.stale-${ulid().toLowerCase()}`;
				try { await fs.promises.rename(lockDir, stale); await fs.promises.rm(stale, { recursive: true, force: true }); recovered = true; }
				catch (renameError) { if ((renameError as any).code !== "ENOENT") throw renameError; }
			}
		}
		this.lock = { nonce: ulid().toLowerCase(), taskId, pid: process.pid, createdAt: new Date().toISOString() };
		await atomicJson(path.join(lockDir, "owner.json"), this.lock);
		if (recovered && !(await this.rollbackToCheckpoint(() => true))) {
			await this.release().catch(() => undefined);
			fail("SESSION_BLOCKED", "Stale writer lock from a dead process and the checkpoint could not be verified; manual inspection required");
		}
	}
	/**
	 * Restore the last verified checkpoint after an unsuccessful run: truncate native/readable files to the recorded
	 * sizes only if the recorded prefix hash still matches, then republish state=ready. Never guesses; false = stay blocked.
	 * Caller must be sure no child process can still write the files.
	 */
	async rollbackToCheckpoint(active: () => boolean): Promise<boolean> {
		try {
			await this.assertLock();
			const disk = await readJson(path.join(this.directory, "manifest.json"));
			if (!record(disk) || disk.id !== this.id) return false;
			const candidate = { ...disk, state: "ready" } as SessionManifest;
			delete candidate.errorCode;
			validateManifest(candidate, this.id);
			const cp = candidate.checkpoint!;
			const file = path.join(this.directory, candidate.nativeFile!);
			await contained(this.root, file); await contained(this.root, this.logPath);
			const size = (await fs.promises.stat(file)).size;
			if (size < cp.nativeBytes || (await fs.promises.stat(this.logPath)).size < cp.readableCommittedBytes) return false;
			const prefix = createHash("sha256");
			if (cp.nativeBytes > 0) for await (const chunk of fs.createReadStream(file, { start: 0, end: cp.nativeBytes - 1 })) prefix.update(chunk);
			if (prefix.digest("hex") !== cp.nativeSha256) return false;
			if (size > cp.nativeBytes) await fs.promises.truncate(file, cp.nativeBytes);
			await fs.promises.truncate(this.logPath, cp.readableCommittedBytes);
			const native = await inspectNative(file, this.id, candidate.config.cwd, cp.nativeBytes);
			if (native.hash !== cp.nativeSha256 || native.bytes !== cp.nativeBytes || native.leafId !== cp.leafId) return false;
			candidate.updatedAt = new Date().toISOString();
			await this.assertLock();
			await atomicJson(path.join(this.directory, "manifest.json"), candidate, active);
			this.manifest = candidate;
			return true;
		} catch { return false; }
	}
	private async assertLock(): Promise<void> {
		if (!this.lock) fail("SESSION_BUSY", "Missing writer ownership");
		const file = path.join(this.directory, "writer.lock", "owner.json");
		await contained(this.root, file);
		const owner = await readJson(file);
		if (owner.nonce !== this.lock.nonce || owner.taskId !== this.lock.taskId) fail("SESSION_BUSY", "Writer lock ownership changed");
	}
	get startupPath() { return path.join(this.runDir, "startup.json"); }
	async acceptStartup(): Promise<void> {
		await contained(this.root, this.startupPath);
		const startup = await readJson(this.startupPath);
		if (startup.errorCode) {
			if (!["MODEL_UNAVAILABLE", "TRUST_REQUIRED", "CONFIG_CHANGED"].includes(startup.errorCode)) fail("METADATA_UNSUPPORTED", "Unknown child startup error");
			fail(startup.errorCode, "Child startup rejected before provider request");
		}
		if (startup.version !== 1 || startup.id !== this.id || startup.cwd !== this.manifest.config.cwd || typeof startup.childTrusted !== "boolean") fail("CONFIG_CHANGED", "Invalid child startup handshake");
		const config = this.manifest.config;
		if (config.childTrusted !== undefined && config.childTrusted !== startup.childTrusted) fail("TRUST_REQUIRED", "Child project trust changed");
		if (!startup.model || (config.model?.includes("/") && startup.model !== config.model) || (config.thinkingLevel && startup.thinkingLevel !== config.thinkingLevel)) fail("CONFIG_CHANGED", "Child model/thinking selection differs from snapshot");
		config.childTrusted = startup.childTrusted;
		config.model = startup.model; config.thinkingLevel = startup.thinkingLevel;
	}
	async release(): Promise<void> {
		if (!this.lock) return;
		const owner = await readJson(path.join(this.directory, "writer.lock", "owner.json"));
		if (owner.nonce !== this.lock.nonce) fail("SESSION_BUSY", "Writer lock ownership changed; not releasing");
		await fs.promises.rm(path.join(this.directory, "writer.lock"), { recursive: true }); this.lock = undefined;
	}
	async validateCheckpoint(): Promise<void> {
		const m = await readJson(path.join(this.directory, "manifest.json")); validateManifest(m, this.id); this.manifest = m;
		if (m.state !== "ready") fail("SESSION_BLOCKED", `Session state is ${m.state}; manual inspection required`);
		await this.diskUsage();
		const file = path.join(this.directory, m.nativeFile!);
		await contained(this.root, file); await contained(this.root, this.logPath);
		const native = await inspectNative(file, this.id, m.config.cwd, m.checkpoint!.nativeBytes);
		if (native.hash !== m.checkpoint!.nativeSha256 || native.bytes !== m.checkpoint!.nativeBytes || native.leafId !== m.checkpoint!.leafId || (await fs.promises.stat(this.logPath)).size !== m.checkpoint!.readableCommittedBytes) fail("CHECKPOINT_MISMATCH", "Native hash/leaf or committed transcript size changed");
	}
	async begin(taskId: string, toolCallId: string, task: string, active: () => boolean): Promise<void> {
		if (!this.lock || this.lock.taskId !== taskId || !SESSION_ID.test(taskId)) fail("SESSION_BUSY", "Missing/mismatched writer lock");
		await this.assertLock();
		await this.diskUsage();
		const dispatchKey = sha256(toolCallId), dispatchFile = path.join(this.directory, "dispatch", `${dispatchKey}.json`);
		try { await fs.promises.writeFile(dispatchFile, JSON.stringify({ taskId, requestHash: sha256(task) }), { flag: "wx", mode: 0o600 }); }
		catch (e) { if ((e as any).code === "EEXIST") return fail("DUPLICATE_DISPATCH", `Already dispatched: ${(await readJson(dispatchFile)).taskId}`); throw e; }
		await fs.promises.mkdir(path.join(this.directory, "runs", taskId), { mode: 0o700 });
		this.run = { version: 1, taskId, dispatchKey, requestHash: sha256(task), oldCommittedBytes: this.manifest.checkpoint?.readableCommittedBytes ?? 0,
			state: "running", startedAt: new Date().toISOString(), ownerNonce: this.lock.nonce };
		await atomicJson(path.join(this.runDir, "run.json"), this.run, active);
		await this.publish("running", active);
	}
	/** Returns true when `restore` rolled a previously ready session back to its verified checkpoint instead of blocking it. */
	async blocked(code: string, details: unknown, active: () => boolean, restore = false): Promise<boolean> {
		if (!this.lock || (!this.run && code !== "CHECKPOINT_MISMATCH")) return false;
		await this.assertLock();
		if (this.run) { this.run.state = "blocked"; this.run.result = details; await atomicJson(path.join(this.runDir, "run.json"), this.run, active); }
		if (restore && await this.rollbackToCheckpoint(active)) return true;
		this.manifest.errorCode = code; await this.publish("blocked", active);
		return false;
	}
	async commit(segment: string, digest: ConversationDigest, result: unknown, active: () => boolean): Promise<void> {
		if (!this.run || !this.lock) fail("COMMIT_FAILED", "No active transaction");
		await this.assertLock();
		await this.diskUsage();
		if (segment !== path.join(this.runDir, "transcript.jsonl")) fail("COMMIT_FAILED", "Segment must belong to the current run");
		await contained(this.root, segment);
		if (!(await fs.promises.stat(segment)).isFile()) fail("COMMIT_FAILED", "Invalid segment");
		const pi = path.join(this.directory, "pi"); await contained(this.root, pi);
		const files: string[] = [];
		for await (const entry of await fs.promises.opendir(pi)) {
			files.push(entry.name);
			if (files.length > 1) fail("CHECKPOINT_MISMATCH", "Multiple native files");
		}
		if (files.length !== 1 || !files[0].endsWith(".jsonl")) fail("CHECKPOINT_MISMATCH", "Expected exactly one native session file");
		const nativeFile = path.join(pi, files[0]); await contained(this.root, nativeFile);
		if (this.manifest.nativeFile && nativeFile !== path.join(this.directory, this.manifest.nativeFile)) fail("CHECKPOINT_MISMATCH", "Native pointer changed");
		const native = await inspectNative(nativeFile, this.id, this.manifest.config.cwd, this.manifest.checkpoint?.nativeBytes ?? 0);
		if (this.manifest.checkpoint && (native.prefixHash !== this.manifest.checkpoint.nativeSha256 || native.prefixLeaf !== this.manifest.checkpoint.leafId)) fail("CHECKPOINT_MISMATCH", "Previous native prefix/leaf changed during invocation");
		if (!digest.users || digest.count !== native.digest.count || digest.value() !== native.digest.value()) fail("CHECKPOINT_MISMATCH", "Native current-run conversation differs from accepted wire messages");
		if (!native.model || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(native.thinkingLevel!)) fail("CONFIG_CHANGED", "Cannot restore native model/thinking selection");
		if (native.model !== this.manifest.config.model || native.thinkingLevel !== this.manifest.config.thinkingLevel) fail("CONFIG_CHANGED", "Child changed saved logical model/thinking selection");
		this.run.state = "committing"; this.run.result = result;
		await atomicJson(path.join(this.runDir, "run.json"), this.run, active); await this.publish("committing", active);
		await this.assertLock();
		const oldBytes = this.run.oldCommittedBytes;
		const output = await fs.promises.open(this.logPath, oldBytes === 0 ? "ax" : "a", 0o600);
		try {
			if ((await output.stat()).size !== oldBytes) fail("CHECKPOINT_MISMATCH", "Uncommitted transcript bytes detected");
			for await (const chunk of fs.createReadStream(segment, { highWaterMark: 64 * 1024 })) {
				if (!active()) fail("COMMIT_FAILED", "Transcript append interrupted");
				await output.writeFile(chunk);
			}
			await output.sync();
			this.manifest.checkpoint = { nativeSha256: native.hash, nativeBytes: native.bytes, readableCommittedBytes: (await output.stat()).size, completedTaskId: this.run.taskId, leafId: native.leafId };
		} finally { await output.close(); }
		await this.diskUsage();
		this.manifest.nativeFile = `pi/${files[0]}`;
		this.manifest.config.model = native.model; this.manifest.config.thinkingLevel = native.thinkingLevel;
		this.run.state = "completed"; this.run.completedAt = new Date().toISOString();
		await atomicJson(path.join(this.runDir, "run.json"), this.run, active); await this.publish("ready", active);
	}
	private async publish(state: SessionState, active: () => boolean): Promise<void> {
		await this.assertLock();
		this.manifest.state = state; this.manifest.updatedAt = new Date().toISOString();
		if (this.run) this.manifest.lastRun = this.run.taskId;
		await atomicJson(path.join(this.directory, "manifest.json"), this.manifest, active);
	}
	async diskUsage(): Promise<number> {
		let bytes = 0, count = 0;
		const visit = async (dir: string, depth: number): Promise<void> => {
			if (depth > 8) fail("SESSION_BLOCKED", "Unexpected managed directory depth");
			const directory = await fs.promises.opendir(dir);
			for await (const entry of directory) {
				if (++count > MAX_SESSION_FILES) fail("SESSION_BLOCKED", "Managed file-count policy exceeded");
				const file = path.join(dir, entry.name); const st = await fs.promises.lstat(file);
				if (st.isSymbolicLink()) fail("CHECKPOINT_MISMATCH", "Managed symlink rejected");
				if (st.isDirectory()) await visit(file, depth + 1);
				else { bytes += st.size; if (bytes > MAX_SESSION_DISK_BYTES) fail("SESSION_BLOCKED", "Managed conversation exceeds 512 MiB soft policy"); }
			}
		};
		await visit(this.directory, 0); return bytes;
	}
}
