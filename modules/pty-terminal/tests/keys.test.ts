import assert from "node:assert/strict";
import test from "node:test";
import { resolveKeys } from "../src/keys.ts";

test("named keys map to terminal sequences, case-insensitively with aliases", () => {
	assert.equal(resolveKeys(["Enter", "tab", "Esc", "Up", "Down", "Left", "Right"]), "\r\t\x1b\x1b[A\x1b[B\x1b[D\x1b[C");
	assert.equal(resolveKeys(["Home", "End", "Backspace", "Delete", "PageUp", "PageDown"]), "\x1b[H\x1b[F\x7f\x1b[3~\x1b[5~\x1b[6~");
	assert.equal(resolveKeys(["Ctrl-A", "ctrl+c", "C-z", "Return", "Escape"]), "\x01\x03\x1a\r\x1b");
});
test("unknown key lists the supported names", () => {
	assert.throws(() => resolveKeys(["Enter", "Hyper-Q"]), (error: Error) => /Unknown key "Hyper-Q"/.test(error.message) && /Enter, Tab/.test(error.message) && /Ctrl-A\.\.Ctrl-Z/.test(error.message));
	assert.throws(() => resolveKeys(["Ctrl-1"]), /Unknown key/);
});
