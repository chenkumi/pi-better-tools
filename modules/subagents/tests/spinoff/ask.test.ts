import assert from "node:assert/strict";
import test from "node:test";
import { askParentUser } from "../../src/spinoff/ask.ts";

const request = (over: Record<string, unknown>) => ({ id: "u1", method: "confirm", title: "Allow?", message: "go", ...over }) as any;
const ctx = (over: Record<string, unknown>) => {
	const calls: any[] = [];
	const ui = { confirm: async (...a: any[]) => { calls.push(["confirm", ...a]); return true; }, select: async (...a: any[]) => { calls.push(["select", ...a]); return "b"; }, editor: async (...a: any[]) => { calls.push(["editor", ...a]); return "edited"; } };
	return { calls, ctx: { hasUI: true, mode: "rpc", ui, ...over } as any };
};
const signal = () => new AbortController().signal;

test("a parent without a UI cancels, so nothing the user never saw is approved", async () => {
	const c = ctx({ hasUI: false });
	assert.deepEqual(await askParentUser(c.ctx, "01JOBABCDEF", request({}), signal()), { cancelled: true });
	assert.deepEqual(c.calls, []);
});

test("the question names the Spinoff, and the host dialogs answer confirm, select and editor", async () => {
	const c = ctx({});
	assert.deepEqual(await askParentUser(c.ctx, "01JOBABCDEF", request({}), signal()), { confirmed: true });
	assert.equal(c.calls[0][1], "Spinoff ABCDEF: Allow?");
	assert.deepEqual(await askParentUser(c.ctx, "01JOBABCDEF", request({ method: "select", options: ["a", "b"] }), signal()), { value: "b" });
	assert.deepEqual(await askParentUser(c.ctx, "01JOBABCDEF", request({ method: "editor", prefill: "x" }), signal()), { value: "edited" });
});

test("an aborted signal, a failing dialog and a missing input answer cancelled", async () => {
	const aborted = new AbortController(); aborted.abort();
	assert.deepEqual(await askParentUser(ctx({}).ctx, "J", request({}), aborted.signal), { cancelled: true });
	const failing = ctx({}); failing.ctx.ui.confirm = async () => { throw new Error("stale context"); };
	assert.deepEqual(await askParentUser(failing.ctx, "J", request({}), signal()), { cancelled: true });
	assert.deepEqual(await askParentUser(ctx({}).ctx, "J", request({ method: "input" }), signal()), { cancelled: true }, "outside the TUI there is no free-text panel");
});
