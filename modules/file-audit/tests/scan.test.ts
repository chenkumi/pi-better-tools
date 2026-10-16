import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, readFile, rm, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/provenance.js";
import { fixture, digest } from "./fixtures/inventory.js";
const candidates = (cwd: string, paths: string[]) => paths.map(path => ({ path: join(cwd, path), action: "read" as const, run: 0 }));

test("scan reads only tracked candidates, reports mismatches, missing and untracked notes", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "modules/native/index.ts"), "changed"); await rm(join(f.cwd, "tests/added.ts"));
    const before = await readFile(join(f.cwd, "docs/adaptations.json"), "utf8");
    const result = await scan(f.cwd, candidates(f.cwd, ["modules/fixture/a.ts", "modules/native/index.ts", "tests/added.ts", "plan/new.md"]));
    assert.deepEqual(result.findings.map(x => x.status), ["matched", "mismatch", "missing", "untracked"]);
    assert.equal(result.bytes, Buffer.byteLength("currentchanged"));
    assert.equal(await readFile(join(f.cwd, "docs/adaptations.json"), "utf8"), before);
  } finally { await f.cleanup(); }
});
test("read budgets, malformed metadata and exclusions never silently pass", async () => {
  const f = await fixture();
  try {
    const paths = candidates(f.cwd, ["modules/fixture/a.ts", "README.md", ".env", "../outside"]);
    const limited = await scan(f.cwd, paths, { maxTotalBytes: 7 });
    assert.deepEqual(limited.findings.map(x => x.status), ["matched", "unavailable", "skipped", "skipped"]);
    assert.equal(limited.bytes, 7); assert.equal(limited.findings[1].reason, "total-budget");
    const single = await scan(f.cwd, paths.slice(0, 1), { maxFileBytes: 1 });
    assert.equal(single.bytes, 0); assert.equal(single.findings[0].reason, "file-budget");
    const meta = await scan(f.cwd, paths, { maxMetadataBytes: 2 });
    assert.equal(meta.metadataBytes, 0); assert.ok(meta.error);
    await writeFile(join(f.cwd, "docs/sources.json"), "{bad json");
    assert.equal((await scan(f.cwd, paths)).error, "invalid-metadata-json");
  } finally { await f.cleanup(); }
});
test("removal records require absence and symlink escape is never content-scanned", async () => {
  const f = await fixture(), outsideFixture = await fixture();
  try {
    const removed = f.adaptations.files.pop()!;
    f.adaptations.removedFiles.push({ path: removed.path, originalSha256: removed.originalSha256, reason: "Removed" }); await f.save();
    const paths = candidates(f.cwd, [removed.path]);
    assert.equal((await scan(f.cwd, paths)).findings[0].status, "mismatch");
    await rm(join(f.cwd, removed.path)); assert.equal((await scan(f.cwd, paths)).findings[0].status, "expected-absent");
    await symlink(outsideFixture.cwd, join(f.cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    f.adaptations.localSourceSuiteFinalIntegration.rootFiles.push({ path: "escape/README.md", sha256: digest("readme") }); await f.save();
    const outside = await scan(f.cwd, candidates(f.cwd, ["escape/README.md"]));
    assert.equal(outside.findings[0].reason, "outside-workspace"); assert.equal(outside.bytes, 0);
    await rm(join(f.cwd, "modules/fixture"), { recursive: true });
    await symlink(outsideFixture.cwd, join(f.cwd, "modules/fixture"), process.platform === "win32" ? "junction" : "dir");
    const absentOutside = await scan(f.cwd, paths);
    assert.equal(absentOutside.findings[0].status, "unavailable"); assert.equal(absentOutside.findings[0].reason, "outside-workspace");
  } finally { await f.cleanup(); await outsideFixture.cleanup(); }
});
test("cancel and a concurrent file change are detected without sleep", async () => {
  const f = await fixture();
  try {
    const paths = candidates(f.cwd, ["modules/fixture/a.ts"]), controller = new AbortController(); controller.abort();
    assert.equal((await scan(f.cwd, paths, { signal: controller.signal })).error, "cancelled");
    const changed = new AbortController(); let count = 0;
    const original = changed.signal.throwIfAborted.bind(changed.signal);
    Object.defineProperty(changed.signal, "throwIfAborted", { value: () => {
      original(); if (++count === 11) writeFileSync(join(f.cwd, "modules/fixture/a.ts"), "concurrent writer");
    } });
    const result = await scan(f.cwd, paths, { signal: changed.signal });
    assert.equal(result.findings[0].status, "unavailable"); assert.equal(result.findings[0].reason, "file-changed");
    assert.ok(result.bytes <= 7);
  } finally { await f.cleanup(); }
});
