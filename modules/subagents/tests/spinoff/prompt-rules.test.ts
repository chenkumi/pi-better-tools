import assert from "node:assert/strict";
import test from "node:test";
import { renderSpinoffRules } from "../../src/spinoff/prompt-rules.ts";

test("the delegation rule names only spinoff and appears only while it is active", () => {
	assert.equal(renderSpinoffRules(new Set(["subagent", "bash"])), undefined);
	const text = renderSpinoffRules(new Set(["spinoff"]))!;
	assert.match(text, /Do quick or tightly coupled/); assert.doesNotMatch(text, /`subagent`/);
	assert.match(text, /result is a claim, not proof/);
});
