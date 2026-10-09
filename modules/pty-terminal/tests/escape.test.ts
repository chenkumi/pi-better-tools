import assert from "node:assert/strict";
import test from "node:test";
import { decodeControlEscapes } from "../src/escape.ts";

test("decodes supported control escapes while leaving other text unchanged", () => {
	assert.equal(decodeControlEscapes("a\\x03b\\r\\u0043\\n\\t"), "a\x03b\rC\n\t");
	assert.equal(decodeControlEscapes("literal \\q"), "literal \\q");
});

test("double backslash and \\x5c decode to one literal backslash in a single pass", () => {
	assert.equal(decodeControlEscapes("C:\\\\new\\\\temp"), "C:\\new\\temp");
	assert.equal(decodeControlEscapes("C:\\x5cnew"), "C:\\new");
	assert.equal(decodeControlEscapes("\\\\n"), "\\n");
	for (const suffix of ["r", "n", "f", "t", "v", "x03", "u0043"]) {
		assert.equal(decodeControlEscapes("\\\\" + suffix), "\\" + suffix, "escaped backslash must shield the following escape");
	}
	assert.equal(decodeControlEscapes("\\\\\\\\"), "\\\\");
	assert.equal(decodeControlEscapes("trailing\\"), "trailing\\");
	assert.equal(decodeControlEscapes("\\x5cu0043"), "\\u0043");
});
