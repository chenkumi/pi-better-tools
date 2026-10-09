import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyStartupReceipt } from "../extensions/subagent/child-startup-receipt.ts";

for (const model of ["多位-模型-é-😀", "literal-\uFFFD"]) test(`byte-exact receipt accepts unchanged Unicode: ${model}`, () => {
  const root = fs.mkdtempSync(join(tmpdir(), "child-shell-bytes-unicode-"));
  const expected = { startupPath: join(root, "startup.json") }, receipt = { version: 1, model };
  try {
    const original = Buffer.from(JSON.stringify(receipt), "utf8");
    verifyStartupReceipt(expected, receipt, true);
    verifyStartupReceipt(expected, receipt, true);
    assert.ok(fs.readFileSync(expected.startupPath).equals(original));
    assert.ok(Buffer.isBuffer((globalThis as any)[Symbol.for("pi-better-tools.subagents.verified-startup-receipts.v1")].get(expected).bytes), "new successful lease stores the original Buffer");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same-inode equal-length invalid UTF-8 must not masquerade as original U+FFFD bytes", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "child-shell-bytes-invalid-"));
  const expected = { startupPath: join(root, "startup.json") }, receipt = { version: 1, model: "literal-\uFFFD" };
  try {
    verifyStartupReceipt(expected, receipt, true);
    const original = fs.readFileSync(expected.startupPath), before = fs.statSync(expected.startupPath, { bigint: true });
    const tampered = Buffer.from(original), offset = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    assert.ok(offset >= 0);
    Buffer.from([0xf0, 0x90, 0x80]).copy(tampered, offset);
    assert.equal(tampered.length, original.length);
    assert.equal(tampered.toString("utf8"), original.toString("utf8"), "the old lossy string check cannot distinguish this mutation");
    assert.ok(!tampered.equals(original));
    fs.writeFileSync(expected.startupPath, tampered);
    const after = fs.statSync(expected.startupPath, { bigint: true });
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    assert.throws(() => verifyStartupReceipt(expected, receipt, true), /ownership\/content changed/);
    assert.ok(fs.readFileSync(expected.startupPath).equals(tampered), "rejection preserves raw tampered evidence");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const tampered of [false, true]) test(`same-object legacy lease upgrades only after raw verification: tampered=${tampered}`, t => {
  const root = fs.mkdtempSync(join(tmpdir(), "child-shell-bytes-legacy-"));
  const expected = { startupPath: join(root, "startup.json") }, receipt = { version: 1, model: "legacy-\uFFFD" };
  try {
    verifyStartupReceipt(expected, receipt, true);
    const state = (globalThis as any)[Symbol.for("pi-better-tools.subagents.verified-startup-receipts.v1")];
    const original = fs.readFileSync(expected.startupPath), legacy = { ...state.get(expected), bytes: original.toString("utf8") };
    state.set(expected, legacy); // The exact pre-fix in-process cache shape; no fresh invocation ownership.
    const evidence = Buffer.from(original);
    if (tampered) Buffer.from([0xf0, 0x90, 0x80]).copy(evidence, original.indexOf(Buffer.from([0xef, 0xbf, 0xbd])));
    fs.writeFileSync(expected.startupPath, evidence);
    t.mock.method(fs, "writeFileSync", () => { assert.fail("revalidation/cache upgrade must not write"); }); syncBuiltinESMExports();
    if (tampered) {
      assert.throws(() => verifyStartupReceipt(expected, receipt, true), /ownership\/content changed/);
      assert.equal(state.get(expected), legacy, "failed raw verification must not upgrade/grant a new lease");
    } else {
      verifyStartupReceipt(expected, receipt, true);
      assert.ok(Buffer.isBuffer(state.get(expected).bytes)); assert.ok(state.get(expected).bytes.equals(original));
    }
    assert.ok(fs.readFileSync(expected.startupPath).equals(evidence));
    assert.throws(() => verifyStartupReceipt({ ...expected }, receipt, true), (error: any) => error.code === "EEXIST");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});
