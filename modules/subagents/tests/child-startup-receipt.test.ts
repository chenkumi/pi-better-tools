import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyStartupReceipt } from "../extensions/subagent/child-startup-receipt.ts";

for (const fault of ["close-failed", "identity-unavailable"] as const) test(`unverified receipt cannot become a reload reuse lease: ${fault}`, t => {
  const root = mkdtempSync(join(tmpdir(), "child-shell-review-receipt-"));
  const expected = { startupPath: join(root, "startup.json") }, receipt = { version: 1, id: "managed" };
  try {
    if (fault === "close-failed") {
      const close = fs.closeSync;
      t.mock.method(fs, "closeSync", (fd: number) => { close(fd); throw new Error("close not acknowledged"); });
    } else {
      const fstat = fs.fstatSync;
      t.mock.method(fs, "fstatSync", ((...args: any[]) => ({ ...Reflect.apply(fstat, fs, args), ino: 0n })) as typeof fs.fstatSync);
    }
    syncBuiltinESMExports();
    assert.throws(() => verifyStartupReceipt(expected, receipt, true), fault === "close-failed" ? /close not acknowledged/ : /ownership\/content changed/);
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.throws(() => verifyStartupReceipt(expected, receipt, true), (error: any) => error.code === "EEXIST", "a merely existing file is not a verified same-invocation lease");
    assert.deepEqual(JSON.parse(fs.readFileSync(expected.startupPath, "utf8")), receipt);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("reload refuses symlink metadata before opening or rewriting the receipt", t => {
  const root = mkdtempSync(join(tmpdir(), "child-shell-review-receipt-"));
  const expected = { startupPath: join(root, "startup.json") }, receipt = { version: 1, id: "managed" };
  try {
    verifyStartupReceipt(expected, receipt, true);
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", ((...args: any[]) => {
      const info = Reflect.apply(lstat, fs, args);
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { isSymbolicLink: () => true });
    }) as typeof fs.lstatSync);
    let opens = 0;
    const open = fs.openSync;
    t.mock.method(fs, "openSync", ((...args: any[]) => { opens++; return Reflect.apply(open, fs, args); }) as typeof fs.openSync);
    syncBuiltinESMExports();
    assert.throws(() => verifyStartupReceipt(expected, receipt, true), /ownership\/content changed/);
    assert.equal(opens, 0);
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.deepEqual(JSON.parse(fs.readFileSync(expected.startupPath, "utf8")), receipt);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
