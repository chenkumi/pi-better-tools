import type { ChildProcess } from "node:child_process";
import { ulid } from "ulid";
import { controlText, messageText, validateInteraction, MAX_QUERY_REPLY_BYTES } from "./query-snapshot.ts";

const MAX_RPC_BYTES = 8 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 30_000;
let activeQueries = 0;
export interface InteractionNotice { kind: "control_result" | "query_result"; [key: string]: unknown }
export interface ControlReceipt { messageId: string; status: "accepted" | "queued" | "applied" | "not_applied" | "delivery_unknown"; timestamp?: unknown; userOrdinal?: number; error?: string }
export interface QueryReceipt { queryId: string; status: "accepted" | "completed" | "failed" | "aborted"; [key: string]: unknown }

/** Bounded correlation and callback-based stdin backpressure. All stdout parsing
 * stays in the existing continuously-drained runner, not a second line reader. */
export class RpcPipe {
	private pending = new Map<string, { type: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private writing: Promise<void> = Promise.resolve();
	private bytes = 0;
	private closed = false;
	constructor(private readonly proc: ChildProcess) { proc.stdin?.on("error", error => this.dispose(error)); }
	request(type: string, params: Record<string, unknown> = {}): Promise<any> {
		if (this.closed || !this.proc.stdin || this.proc.stdin.destroyed) return Promise.reject(new Error("RPC_CLOSED: child transport is closed"));
		const id = ulid().toLowerCase(); const data = JSON.stringify({ ...params, id, type }) + "\n";
		const bytes = Buffer.byteLength(data, "utf8");
		if (this.pending.size >= 16 || bytes > MAX_RPC_BYTES || this.bytes + bytes > MAX_RPC_BYTES) return Promise.reject(new Error("RPC_CAPACITY: bounded command queue exceeded"));
		this.bytes += bytes;
		const response = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC_DEADLINE: ${type} response not received`)); }, REQUEST_DEADLINE_MS);
			this.pending.set(id, { type, resolve, reject, timer });
		});
		this.writing = this.writing.then(() => new Promise<void>((resolve, reject) => {
			if (this.closed || !this.proc.stdin || this.proc.stdin.destroyed) { reject(new Error("RPC_CLOSED")); return; }
			this.proc.stdin.write(data, error => error ? reject(error) : resolve());
		})).catch(error => { this.dispose(error instanceof Error ? error : new Error(String(error))); }).finally(() => { this.bytes -= bytes; });
		return response;
	}
	accept(event: Record<string, unknown>): boolean {
		if (event.type !== "response") return false;
		if (typeof event.id !== "string") throw new Error("RPC_PROTOCOL: uncorrelated response");
		const request = this.pending.get(event.id); if (!request) return true;
		this.pending.delete(event.id); clearTimeout(request.timer);
		if (event.command !== request.type || typeof event.success !== "boolean") request.reject(new Error("RPC_PROTOCOL: response command mismatch"));
		else if (!event.success) request.reject(new Error(typeof event.error === "string" ? event.error : "RPC command rejected"));
		else request.resolve(event.data);
		return true;
	}
	async end() {
		this.closed = true; // No late queued steer can revive a settled child.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.writing, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("RPC_SHUTDOWN: stdin backpressure did not settle within 5 seconds")), 5000); })]);
			if (this.proc.stdin && !this.proc.stdin.destroyed) this.proc.stdin.end();
		} catch (error) {
			this.proc.stdin?.destroy(); this.dispose(error instanceof Error ? error : new Error(String(error))); throw error;
		} finally { if (timer) clearTimeout(timer); }
	}
	dispose(error = new Error("RPC_CLOSED: child exited")) {
		this.closed = true;
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
		this.pending.clear();
	}
}

export class RpcInteraction {
	readonly pipe: RpcPipe;
	private controls = new Map<string, { receipt: ControlReceipt; text: string; sent: boolean }>();
	private queries = new Map<string, { receipt: QueryReceipt; active: boolean; done: Promise<void>; finish: () => void; timer: ReturnType<typeof setTimeout> }>();
	private tail: Promise<void> = Promise.resolve();
	private running = false;
	private closed = false;
	private cancelled = false;
	constructor(private readonly proc: ChildProcess, private readonly token: string, private readonly model: string, private readonly notify: (notice: InteractionNotice) => void) {
		this.pipe = new RpcPipe(proc);
		proc.on("message", input => this.receive(input));
		proc.once("close", () => this.transportClosed());
	}
	start() { if (!this.closed) this.running = true; }
	get isRunning() { return this.running && !this.closed; }
	snapshot() { return { controls: [...this.controls.values()].map(c => ({ ...c.receipt })), queries: [...this.queries.values()].map(q => ({ ...q.receipt })) }; }
	private emit(notice: InteractionNotice) { try { this.notify(notice); } catch { /* observer cannot affect child settlement */ } }
	control(message: string) {
		validateInteraction(message);
		if (!this.isRunning) throw new Error("TASK_NOT_RUNNING: wait for ready and use resume");
		if (this.controls.size >= 32) throw new Error("CONTROL_CAPACITY: at most 32 controls per invocation");
		const receipt: ControlReceipt = { messageId: ulid().toLowerCase(), status: "accepted" };
		const record = { receipt, text: controlText(receipt.messageId, message), sent: false };
		this.controls.set(receipt.messageId, record);
		this.tail = this.tail.then(async () => {
			if (!this.isRunning) return;
			record.sent = true;
			try {
				const response = await this.pipe.request("steer", { message: record.text });
				if (record.receipt.status !== "accepted") return;
				if (response?.disposition === "queued") record.receipt.status = "queued";
				else {
					record.receipt.status = response?.disposition === "handled" ? "not_applied" : "delivery_unknown";
					record.receipt.error = response?.disposition === "handled" ? "Child input handler consumed the control; no canonical application confirmed" : "Unrecognized child disposition; canonical delivery is unknown";
					this.emit({ kind: "control_result", ...record.receipt });
				}
			} catch (error) {
				if (!["accepted", "queued"].includes(record.receipt.status)) return;
				record.receipt.status = "delivery_unknown"; record.receipt.error = error instanceof Error ? error.message : String(error);
				this.emit({ kind: "control_result", ...record.receipt });
			}
		});
		return { ...receipt };
	}
	user(message: Record<string, unknown>, ordinal: number) {
		if (this.closed) return;
		const text = messageText(message.content);
		for (const record of this.controls.values()) if (record.sent && record.text && record.text === text && record.receipt.status !== "applied") {
			record.receipt.status = "applied"; record.receipt.timestamp = message.timestamp; record.receipt.userOrdinal = ordinal;
			this.emit({ kind: "control_result", ...record.receipt }); record.text = ""; break;
		}
	}
	query(message: string) {
		validateInteraction(message);
		if (!this.isRunning) throw new Error("TASK_NOT_RUNNING: queries require an active RPC child");
		if (!this.proc.connected || typeof this.proc.send !== "function") throw new Error("QUERY_TRANSPORT_UNAVAILABLE: child IPC is disconnected");
		if (activeQueries >= 8 || [...this.queries.values()].filter(q => q.active).length >= 2 || this.queries.size >= 32) throw new Error("QUERY_CAPACITY: at most 8 process-wide, 2 active and 32 retained queries per task");
		const receipt: QueryReceipt = { queryId: ulid().toLowerCase(), status: "accepted" };
		let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
		const timer = setTimeout(() => this.expireQuery(receipt.queryId), REQUEST_DEADLINE_MS);
		this.queries.set(receipt.queryId, { receipt, active: true, done, finish, timer }); activeQueries++;
		const data = { channel: "pi-subagent-query", token: this.token, type: "query", queryId: receipt.queryId, message };
		try { this.proc.send!(data, error => { if (error) this.expireQuery(receipt.queryId, error.message); }); }
		catch (error) { this.expireQuery(receipt.queryId, String(error)); }
		return { ...receipt };
	}
	private receive(input: unknown) {
		if (!input || typeof input !== "object" || Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_QUERY_REPLY_BYTES) return;
		const value = input as Record<string, unknown>;
		if (value.channel !== "pi-subagent-query" || value.token !== this.token || value.type !== "query_result" || typeof value.queryId !== "string") return;
		if (!["completed", "failed", "aborted"].includes(String(value.status))) return;
		if (value.status === "completed" && `${value.provider}/${value.model}` !== this.model && !(!this.model.includes("/") && value.model === this.model)) { this.finishQuery(value.queryId, { status: "failed", error: "QUERY_CONFIG_CHANGED: result model mismatch", usage: value.usage }); return; }
		const result = Object.fromEntries(["status", "output", "outputTruncated", "asOf", "usage", "usageUnknown", "snapshotUnavailable", "provider", "model", "error"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
		this.finishQuery(value.queryId, result);
	}
	private expireQuery(id: string, error = "QUERY_DEADLINE: no child result received") {
		const query = this.queries.get(id); if (!query || query.receipt.status !== "accepted") return;
		clearTimeout(query.timer);
		Object.assign(query.receipt, { status: this.cancelled ? "aborted" : "failed", error, usageUnknown: true, cleanupPending: query.active }); query.finish();
		// A failed receipt is NOT proof that the provider stopped. Retain the
		// process-wide/per-task lease until a terminal IPC result or child exit.
		if (this.proc.connected) { try { this.proc.send!({ channel: "pi-subagent-query", token: this.token, type: "cancel_query", queryId: id }, () => {}); } catch {} }
		this.emit({ kind: "query_result", ...query.receipt });
	}
	private finishQuery(id: string, result: Record<string, unknown>) {
		const query = this.queries.get(id); if (!query?.active) return;
		clearTimeout(query.timer); query.active = false; activeQueries--;
		if (query.receipt.status === "accepted") {
			Object.assign(query.receipt, result, { cleanupPending: false }); query.finish();
			this.emit({ kind: "query_result", ...query.receipt });
		} else {
			query.receipt.cleanupPending = false;
			// Do not revive an expired answer; late terminal evidence may reconcile
			// its independent usage/asOf, never the mainline or host accounting.
			if (result.usage !== undefined) {
				Object.assign(query.receipt, { usage: result.usage, usageUnknown: false, ...(result.asOf !== undefined ? { asOf: result.asOf } : {}) });
				this.emit({ kind: "query_result", ...query.receipt, lateUsage: true });
			}
		}
	}
	cancelQueries() {
		this.cancelled = true;
		if (this.proc.connected) { try { this.proc.send!({ channel: "pi-subagent-query", token: this.token, type: "cancel_queries" }, () => {}); } catch {} }
	}
	async settled() {
		this.running = false;
		for (const record of this.controls.values()) if (["accepted", "queued"].includes(record.receipt.status)) {
			// Input hooks may transform queued text (including its correlation prefix).
			// Only unsent controls are provably not applied.
			record.receipt.status = record.sent ? "delivery_unknown" : "not_applied";
			this.emit({ kind: "control_result", ...record.receipt }); record.text = "";
		}
		// A query does not keep the main task running forever. Every accepted query
		// has its own bounded deadline; after it settles close RPC stdin orderly.
		await Promise.all([...this.queries.values()].map(query => query.done));
		await this.pipe.end();
	}
	close(aborted = false) {
		this.running = false; this.closed = true; this.cancelled ||= aborted;
		this.pipe.dispose();
		for (const record of this.controls.values()) if (["accepted", "queued"].includes(record.receipt.status)) {
			record.receipt.status = record.sent ? "delivery_unknown" : "not_applied";
			this.emit({ kind: "control_result", ...record.receipt }); record.text = "";
		}
		for (const record of this.controls.values()) record.text = "";
		for (const query of this.queries.values()) if (query.active) this.expireQuery(query.receipt.queryId, "Runner closed; child termination is not yet confirmed");
	}
	/** Only a real child close event or terminal IPC proves provider work is gone.
	 * Runner abandonment/background finalization must never release these leases. */
	transportClosed() {
		this.running = false; this.closed = true;
		for (const query of this.queries.values()) if (query.active) this.finishQuery(query.receipt.queryId, { status: this.cancelled ? "aborted" : "failed", error: "Child transport closed before query result", usageUnknown: true });
		this.close();
	}
}
