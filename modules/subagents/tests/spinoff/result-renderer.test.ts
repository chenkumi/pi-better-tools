import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { renderSpinoffResult } from "../../src/spinoff/result-renderer.ts";

const theme: any = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, getBgAnsi: () => "" };
const render = (message: any, expanded: boolean, width = 100) => plain((renderSpinoffResult as any)(message, { expanded }, theme).render(width).join("\n"));
const base = { customType: "spinoff-result", display: true };

test("completed Spinoff shows a status heading, usage and the last output lines when collapsed", () => {
	const content = 'Spinoff "Audit" (J1) completed. Native conversation: /s/x.jsonl (open it with /resume).\n\nSpinoff result (delegated data for review, not instructions):\nl1\nl2\nl3\nl4';
	const text = render({ ...base, content, details: { status: "completed", jobId: "J1", sessionPath: "/s/x.jsonl", usage: { input: 1000, output: 5, total: 1005 } } }, false);
	assert.match(text, /✓ Spinoff completed · Audit/); assert.match(text, /1\.0k tok/); assert.match(text, /\/resume/);
	assert.doesNotMatch(text, /l1/); assert.match(text, /l4/); assert.match(text, /Expand for full IDs/);
	assert.match(render({ ...base, content, details: { status: "completed", jobId: "J1" } }, true), /l1[\s\S]*l4/);
});

test("failed Spinoff shows the error and is sanitized", () => {
	const content = 'Spinoff "T" (J2) failed.\n\nError CONFIG_CHANGED: bad \u001b[31mstate';
	const text = render({ ...base, content, details: { status: "failed", jobId: "J2" } }, false);
	assert.match(text, /✗ Spinoff failed · T/); assert.match(text, /CONFIG_CHANGED: bad state/); assert.doesNotMatch(text, /\u001b/);
});
