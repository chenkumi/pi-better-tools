import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyStartupReceipt } from "../extensions/subagent/child-startup-receipt.ts";

const faults = ["lstat-open-replacement", "lstat-open-symlink", "lstat-open-metadata", "lstat-metadata-unavailable", "open-fstat-descriptor-mismatch", "fstat-read-replacement", "read-postcheck-symlink", "read-postcheck-size", "read-postcheck-bytes", "read-postcheck-metadata", "postread-metadata-unavailable", "postcheck-replacement"] as const;
for (const phase of ["initial-validation", "reload"] as const) for (const fault of faults) {
  test(`deterministic receipt ${phase} rejects ${fault} without writes/new lease`, t => {
    const root = fs.mkdtempSync(join(tmpdir(), "child-shell-bytes-race-"));
    const expected = { startupPath: join(root, "startup.json") }, receipt = { version: 1, model: "多位-\uFFFD-😀" };
    const bytes = Buffer.from(JSON.stringify(receipt), "utf8"), backup = expected.startupPath + ".owned", foreign = join(root, "foreign.json");
    const real = { open: fs.openSync, close: fs.closeSync, lstat: fs.lstatSync, fstat: fs.fstatSync, read: fs.readFileSync, write: fs.writeFileSync };
    const readFDs = new Set<number>(), allReadFDs = new Set<number>(), closedFDs = new Set<number>();
    let triggered = false, virtualSymlink = false, metadataChanged = false, readFinished = false, lstats = 0, writes = 0;
    let readSnapshot: fs.BigIntStats | undefined;
    const clone = (info: fs.BigIntStats, overrides: object) => Object.assign(Object.create(Object.getPrototypeOf(info)), info, overrides);
    const metadataDelta = (info: fs.BigIntStats) => clone(info, { mtimeNs: (readSnapshot ?? info).mtimeNs + 1n, ctimeNs: (readSnapshot ?? info).ctimeNs + 1n });
    const replace = () => { fs.renameSync(expected.startupPath, backup); real.write(expected.startupPath, bytes); triggered = true; };
    try {
      real.write(foreign, bytes);
      if (phase === "reload") verifyStartupReceipt(expected, receipt, true);
      t.mock.method(fs, "writeFileSync", ((...args: any[]) => { writes++; return Reflect.apply(real.write, fs, args); }) as typeof fs.writeFileSync);
      t.mock.method(fs, "lstatSync", ((...args: any[]) => {
        lstats++;
        if (lstats === 2 && fault === "postcheck-replacement") replace();
        const info = Reflect.apply(real.lstat, fs, args);
        // Snapshot the first lookup, then switch the path before open. Symlinks
        // are metadata injection: no Windows privilege/skip or timing dependency.
        if (lstats === 1 && fault === "lstat-open-replacement") replace();
        if (lstats === 1 && fault === "lstat-open-symlink") { triggered = true; virtualSymlink = true; return info; }
        if (lstats === 1 && fault === "lstat-open-metadata") { triggered = true; metadataChanged = true; return info; }
        if (lstats === 1 && fault === "lstat-metadata-unavailable") { triggered = true; return clone(info, { mtimeNs: undefined }); }
        if (virtualSymlink) return clone(info, { isSymbolicLink: () => true });
        if (metadataChanged) return metadataDelta(info);
        return info;
      }) as typeof fs.lstatSync);
      t.mock.method(fs, "openSync", ((...args: any[]) => {
        if (typeof args[1] === "number" && fault === "open-fstat-descriptor-mismatch") { args[0] = foreign; triggered = true; }
        const fd = Reflect.apply(real.open, fs, args);
        if (typeof args[1] === "number") { readFDs.add(fd); allReadFDs.add(fd); }
        return fd;
      }) as typeof fs.openSync);
      t.mock.method(fs, "closeSync", (fd: number) => { real.close(fd); if (readFDs.delete(fd)) closedFDs.add(fd); });
      t.mock.method(fs, "fstatSync", ((...args: any[]) => {
        const info = Reflect.apply(real.fstat, fs, args);
        if (!readFDs.has(args[0])) return info;
        if (!readFinished) readSnapshot ??= info;
        if (readFinished && fault === "postread-metadata-unavailable") { triggered = true; return clone(info, { ctimeNs: undefined }); }
        if (!triggered && fault === "fstat-read-replacement") replace();
        if (readFinished && fault === "read-postcheck-metadata") { triggered = true; metadataChanged = true; }
        if (metadataChanged) return metadataDelta(info);
        return info;
      }) as typeof fs.fstatSync);
      t.mock.method(fs, "readFileSync", ((...args: any[]) => {
        const result = Reflect.apply(real.read, fs, args);
        if (typeof args[0] !== "number" || !readFDs.has(args[0])) return result;
        readFinished = true;
        if (fault === "read-postcheck-symlink") { triggered = true; virtualSymlink = true; }
        if (fault === "read-postcheck-size") {
          triggered = true;
          // appendFileSync delegates to the exported writeFileSync spy. Use the
          // captured fd primitives so attacker I/O is not counted as verifier I/O.
          const growFD = real.open(expected.startupPath, "a");
          try { real.write(growFD, "!"); } finally { real.close(growFD); }
        }
        if (fault === "read-postcheck-bytes") {
          triggered = true; metadataChanged = true; // Deterministic observed timestamp change; no clock-resolution dependence.
          real.write(expected.startupPath, Buffer.concat([Buffer.from("x"), bytes.subarray(1)]));
        }
        return result;
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      assert.throws(() => verifyStartupReceipt(expected, receipt, true), /ownership\/content changed/);
      assert.equal(triggered, true, "the exact injected phase must be observed");
      assert.equal(writes, phase === "reload" ? 0 : 1, "only the initial exclusive write is permitted; verification never writes");
      assert.deepEqual(closedFDs, allReadFDs, "every opened verification descriptor is closed after rejection");
      t.mock.restoreAll(); syncBuiltinESMExports();
      const evidence = real.read(expected.startupPath);
      if (fault === "read-postcheck-size") assert.ok(evidence.equals(Buffer.concat([bytes, Buffer.from("!")])));
      else if (fault === "read-postcheck-bytes") assert.ok(evidence.equals(Buffer.concat([Buffer.from("x"), bytes.subarray(1)])));
      else assert.ok(evidence.equals(bytes), "no overwrite of replacement/current evidence");
      // Restore the exact original inode/bytes only as test cleanup/control. An
      // erroneously granted initial lease would now succeed, exposing the bug.
      if (fs.existsSync(backup)) { fs.unlinkSync(expected.startupPath); fs.renameSync(backup, expected.startupPath); }
      real.write(expected.startupPath, bytes);
      if (phase === "initial-validation") assert.throws(() => verifyStartupReceipt(expected, receipt, true), (error: any) => error.code === "EEXIST", "failed validation must not have acquired a lease");
      else verifyStartupReceipt(expected, receipt, true); // Existing legitimate lease is not replaced/adopted.
      assert.throws(() => verifyStartupReceipt({ ...expected }, receipt, true), (error: any) => error.code === "EEXIST", "fresh invocation still has no ownership");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
