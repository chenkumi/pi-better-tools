import assert from "node:assert/strict";
import test from "node:test";
import { decodeControlEscapes } from "../src/escape.ts";

test("decodes supported control escapes while leaving other text unchanged", () => {
	assert.equal(decodeControlEscapes("a\\x03b\\r\\u0043\\n\\t"), "a\x03b\rC\n\t");
	assert.equal(decodeControlEscapes("literal \\q"), "literal \\q");
});
