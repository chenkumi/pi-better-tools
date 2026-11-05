import assert from "node:assert/strict";
import test from "node:test";
import { renderSubagentRules } from "../extensions/subagent/prompt-rules.ts";

test("the delegation rule names only subagent and appears only while it is active", () => {
	assert.equal(renderSubagentRules(new Set(["fork", "bash"])), undefined);
	const text = renderSubagentRules(new Set(["subagent"]))!;
	assert.match(text, /delegate only self-contained/); assert.doesNotMatch(text, /fork/);
	assert.match(text, /Delegated output is a claim, not proof/);
});
