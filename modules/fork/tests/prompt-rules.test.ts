import assert from "node:assert/strict";
import test from "node:test";
import { renderForkRules } from "../src/prompt-rules.ts";

test("the delegation rule names only fork and appears only while it is active", () => {
	assert.equal(renderForkRules(new Set(["subagent", "bash"])), undefined);
	const text = renderForkRules(new Set(["fork"]))!;
	assert.match(text, /`fork` for long work/); assert.doesNotMatch(text, /`subagent`/);
	assert.match(text, /Delegated output is a claim, not proof/);
});
