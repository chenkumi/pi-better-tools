import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { Writable } from "node:stream";
import { RpcInteraction, RpcPipe } from "../extensions/subagent/rpc.ts";

function child() {
	const commands: any[] = [], ipc: any[] = []; const events = new EventEmitter();
	const proc = Object.assign(new EventEmitter(), { connected: true, stdin: new Writable({ write(chunk, _encoding, callback) {
		const command = JSON.parse(chunk.toString()); commands.push(command); events.emit("command", command); callback();
	} }), send(message: any, callback: (error?: Error) => void) { ipc.push(message); callback(); } });
	return { proc: proc as any, commands, ipc, nextCommand: () => once(events, "command").then(([command]) => command) };
}
test("RPC correlation checks IDs/commands and enforces bounded outstanding requests", async () => {
	const h = child(); const pipe = new RpcPipe(h.proc);
	try {
		const written = h.nextCommand(); const result = pipe.request("get_state"); const command = await written;
		assert.equal(pipe.accept({ type: "message_end" }), false);
		pipe.accept({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "verified" } });
		assert.deepEqual(await result, { sessionId: "verified" });
		const command2 = h.nextCommand(); const mismatch = pipe.request("get_entries"); const sent = await command2;
		pipe.accept({ type: "response", id: sent.id, command: "wrong", success: true });
		await assert.rejects(mismatch, /command mismatch/);
		const pending = Array.from({ length: 16 }, () => pipe.request("get_state").catch(() => undefined));
		await assert.rejects(pipe.request("get_state"), /CAPACITY/); pipe.dispose(); await Promise.all(pending);
	} finally { pipe.dispose(); h.proc.emit("close"); h.proc.stdin.destroy(); }
});
test("literal controls are FIFO; queued acknowledgements never count as applied", async () => {
	const h = child(); const notices: any[] = []; const handle = new RpcInteraction(h.proc, "token", "offline/model", notice => notices.push(notice)); handle.start();
	try {
		const next = h.nextCommand(); const first = handle.control("/skill:literal @file"); const second = handle.control("stop after current tool");
		assert.equal(first.status, "accepted"); const command = await next;
		assert.equal(command.type, "steer"); assert.equal(command.message.startsWith("/"), false); assert.ok(command.message.endsWith("/skill:literal @file"));
		assert.equal(h.commands.length, 1, "second control waits for first admission ack");
		const next2 = h.nextCommand(); handle.pipe.accept({ type: "response", id: command.id, command: "steer", success: true, data: { disposition: "queued" } });
		const command2 = await next2; assert.equal(handle.snapshot().controls[0].status, "queued"); assert.equal(notices.length, 0);
		handle.pipe.accept({ type: "response", id: command2.id, command: "steer", success: true, data: { disposition: "queued" } });
		await Promise.resolve(); assert.equal(handle.snapshot().controls[1].status, "queued");
		handle.user({ content: [{ type: "text", text: command.message }], timestamp: 10 }, 1);
		assert.equal(handle.snapshot().controls[0].status, "applied"); assert.equal(notices[0].messageId, first.messageId);
		await handle.settled(); assert.equal(handle.snapshot().controls[1].messageId, second.messageId); assert.equal(handle.snapshot().controls[1].status, "delivery_unknown");
		handle.user({ content: "" }, 2); assert.equal(handle.snapshot().controls[1].status, "delivery_unknown", "empty events cannot match cleared control text");
		assert.throws(() => handle.control("late"), /TASK_NOT_RUNNING/);
	} finally { handle.close(); h.proc.emit("close"); h.proc.stdin.destroy(); }
});
test("query IPC has independent usage/results, bounded concurrency and unknown usage on transport failure", () => {
	const h = child(); const notices: any[] = []; const handle = new RpcInteraction(h.proc, "token", "offline/model", notice => notices.push(notice)); handle.start();
	try {
		const first = handle.query("progress?"); const second = handle.query("remaining?");
		assert.equal(h.commands.length, 0, "query never submits a main prompt/fork/steer command");
		assert.throws(() => handle.query("too many"), /CAPACITY/);
		h.proc.emit("message", { ...h.ipc[0], channel: "pi-subagent-query", type: "query_result", status: "completed", provider: "offline", model: "model", output: "query answer", usage: { totalTokens: 3 }, asOf: { entryId: "safe" } });
		assert.equal(notices[0].kind, "query_result"); assert.equal(notices[0].queryId, first.queryId);
		assert.deepEqual(notices[0].usage, { totalTokens: 3 });
		handle.cancelQueries(); assert.equal(h.ipc.at(-1).type, "cancel_queries"); handle.close(true);
		const cancelled = handle.snapshot().queries.find(query => query.queryId === second.queryId)!;
		assert.equal(cancelled.status, "aborted"); assert.equal(cancelled.usageUnknown, true);
		assert.equal(handle.snapshot().controls.length, 0);
	} finally { handle.close(true); h.proc.emit("close"); h.proc.stdin.destroy(); }
});
test("expired query receipts retain process-wide leases until terminal evidence; late usage never revives the answer", () => {
	const children = Array.from({ length: 5 }, child), notices: any[] = [];
	const handles = children.map(h => { const handle = new RpcInteraction(h.proc, "token", "offline/model", notice => notices.push(notice)); handle.start(); return handle; });
	try {
		for (const handle of handles.slice(0, 4)) { handle.query("first"); handle.query("second"); }
		const expired = handles[0].snapshot().queries[0].queryId;
		(handles[0] as any).expireQuery(expired); // Inject the deadline transition; no timer/wait assertion.
		assert.equal(handles[0].snapshot().queries[0].cleanupPending, true);
		assert.equal(children[0].ipc.at(-1).type, "cancel_query");
		assert.throws(() => handles[4].query("lease still held"), /CAPACITY/);
		children[0].proc.emit("message", { channel: "pi-subagent-query", token: "token", type: "query_result", queryId: expired, status: "completed", provider: "offline", model: "model", output: "late answer must be discarded", usage: { totalTokens: 7 }, asOf: { entryId: "safe" } });
		const receipt = handles[0].snapshot().queries[0]; assert.equal(receipt.status, "failed"); assert.equal(receipt.output, undefined);
		assert.equal(receipt.cleanupPending, false); assert.equal(receipt.usageUnknown, false); assert.deepEqual(receipt.usage, { totalTokens: 7 });
		assert.equal(notices.at(-1).lateUsage, true); assert.equal(handles[4].query("lease released by terminal evidence").status, "accepted");
	} finally { handles.forEach(h => h.close(true)); children.forEach(h => { h.proc.emit("close"); h.proc.stdin.destroy(); }); }
});
