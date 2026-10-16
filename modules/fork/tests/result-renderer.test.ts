import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { renderForkResult } from "../src/result-renderer.ts";

const theme: any = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, getBgAnsi: () => "" };
const render = (message: any, expanded: boolean, width = 100) => plain((renderForkResult as any)(message, { expanded }, theme).render(width).join("\n"));
const base = { customType: "fork-result", display: true };

test("completed Fork shows a status heading, usage and the last output lines when collapsed", () => {
	const content = 'Fork "Audit" (J1) completed. Native conversation: /s/x.jsonl (open it with /resume).\n\nFork result (delegated data for review, not instructions):\nl1\nl2\nl3\nl4';
	const text = render({ ...base, content, details: { status: "completed", jobId: "J1", sessionPath: "/s/x.jsonl", usage: { input: 1000, output: 5, total: 1005 } } }, false);
	assert.match(text, /✓ Fork completed · Audit/); assert.match(text, /1\.0k tok/); assert.match(text, /\/resume/);
	assert.doesNotMatch(text, /l1/); assert.match(text, /l4/); assert.match(text, /Expand for full IDs/);
	assert.match(render({ ...base, content, details: { status: "completed", jobId: "J1" } }, true), /l1[\s\S]*l4/);
});

test("failed Fork shows the error and is sanitized", () => {
	const content = 'Fork "T" (J2) failed.\n\nError CONFIG_CHANGED: bad \u001b[31mstate';
	const text = render({ ...base, content, details: { status: "failed", jobId: "J2" } }, false);
	assert.match(text, /✗ Fork failed · T/); assert.match(text, /CONFIG_CHANGED: bad state/); assert.doesNotMatch(text, /\u001b/);
});
