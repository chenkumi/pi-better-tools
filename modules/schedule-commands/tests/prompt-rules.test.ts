import assert from "node:assert/strict";
import test from "node:test";
import { renderScheduleRules } from "../src/prompt-rules.ts";

test("schedule rules appear only while a schedule tool is active and mention only the active ones", () => {
	assert.equal(renderScheduleRules(new Set(["bash", "read"])), undefined);
	const both = renderScheduleRules(new Set(["schedule_prompt", "schedule_shell"]))!;
	assert.match(both, /schedule_shell/); assert.match(both, /schedule_prompt/);
	const onlyPrompt = renderScheduleRules(new Set(["schedule_prompt"]))!;
	assert.doesNotMatch(onlyPrompt, /schedule_shell/);
	const onlyShell = renderScheduleRules(new Set(["schedule_shell"]))!;
	assert.doesNotMatch(onlyShell, /schedule_prompt/);
	for (const text of [both, onlyPrompt, onlyShell]) assert.ok(text.length < 700 && !/\n\n|\n$/.test(text), "short, no blank lines");
});
