import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { RpcInteraction } from "../extensions/subagent/rpc.ts";

test("abandoned receipts retain query leases until actual child close or terminal reply", async () => {
	const children = Array.from({ length: 5 }, () => Object.assign(new EventEmitter(), {
		connected: true, stdin: new Writable({ write(_data, _encoding, cb) { cb(); } }),
		send(_message: unknown, cb: (error?: Error) => void) { cb(); },
	}));
	const handles = children.map(proc => { const h = new RpcInteraction(proc as any, "token", "offline/model", () => {}); h.start(); return h; });
	try {
		for (const h of handles.slice(0, 4)) { h.query("first"); h.query("second"); h.close(true); await h.settled(); }
		for (const h of handles.slice(0, 4)) for (const q of h.snapshot().queries) { assert.equal(q.status, "aborted"); assert.equal(q.cleanupPending, true); }
		assert.throws(() => handles[4].query("provider still running"), /CAPACITY/);
		children[0].emit("close");
		assert.equal(handles[0].snapshot().queries[0].cleanupPending, false);
		handles[4].query("close proved resources gone"); handles[4].query("second released lease");
		const q = handles[1].snapshot().queries[0];
		children[1].emit("message", { channel: "pi-subagent-query", token: "token", type: "query_result", queryId: q.queryId, status: "aborted", usageUnknown: true });
		assert.equal(handles[1].snapshot().queries[0].cleanupPending, false);
		assert.equal(handles[1].snapshot().queries[1].cleanupPending, true, "terminal reply releases only its own lease");
	} finally { handles.forEach(h => h.close(true)); children.forEach(p => { p.emit("close"); p.stdin.destroy(); }); }
});
