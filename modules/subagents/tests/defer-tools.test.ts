import assert from "node:assert/strict";
import test from "node:test";
import { deferActivatedTools } from "../extensions/subagent/defer-tools.ts";

const tools = [{ name: "read" }, { name: "tool_search" }, { name: "sqlite_query", exposure: "deferred" }, { name: "mysql_query", exposure: "deferred" }, { name: "web_fetch", exposure: "direct" }];
function host(active: string[]) {
	let current = active;
	return { pi: { getActiveTools: () => current, getAllTools: () => tools, setActiveTools: (next: string[]) => { current = next; } } as any, active: () => current };
}

test("deferred tools named in --tools are deactivated so tool_search loads them", () => {
	const h = host(["read", "tool_search", "sqlite_query", "mysql_query", "web_fetch"]);
	deferActivatedTools(h.pi);
	assert.deepEqual(h.active(), ["read", "tool_search", "web_fetch"]);
});

test("without tool_search the deferred tools stay declared directly", () => {
	const h = host(["read", "sqlite_query"]);
	deferActivatedTools(h.pi);
	assert.deepEqual(h.active(), ["read", "sqlite_query"]);
});

test("nothing to defer leaves the active set untouched", () => {
	let calls = 0;
	deferActivatedTools({ getActiveTools: () => ["read", "tool_search"], getAllTools: () => tools, setActiveTools: () => { calls++; } } as any);
	assert.equal(calls, 0);
});
