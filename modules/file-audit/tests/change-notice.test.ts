import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ChangeNotice, changeMessage, CHANGE_MESSAGE_TYPE } from "../src/change-notice.js";

async function withDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "file-audit-change-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
test("unchanged, touched-only, modified and deleted files are told apart", () => withDir(async cwd => {
  const a = join(cwd, "a.txt"), b = join(cwd, "b.txt"), c = join(cwd, "c.txt");
  for (const f of [a, b, c]) await writeFile(f, "one");
  const n = new ChangeNotice();
  for (const f of [a, b, c]) n.record(f, 50);
  await sleep(150); // let the baseline hashes settle
  assert.deepEqual(await n.detect([a, b, c]), []);
  const later = new Date(Date.now() + 5000);
  await utimes(a, later, later); // mtime only: same content
  await writeFile(b, "two"); // different content, same size
  await utimes(b, later, later);
  await unlink(c);
  const changes = await n.detect([a, b, c]);
  assert.deepEqual(changes.map(x => [x.path, x.change]), [[b, "modified"], [c, "deleted"]]);
  assert.deepEqual(await n.detect([a, b, c]), [], "baselines refresh, so the same change is reported once");
}));
test("credential paths are not observed, clear forgets everything, capacity is bounded", () => withDir(async cwd => {
  const env = join(cwd, ".env"), x = join(cwd, "x.txt"), y = join(cwd, "y.txt");
  for (const f of [env, x, y]) await writeFile(f, "v1");
  const n = new ChangeNotice();
  n.record(env, 50); n.record(x, 1); n.record(y, 1);
  await writeFile(env, "v2"); await writeFile(x, "v22"); await writeFile(y, "v22");
  assert.deepEqual((await n.detect([env, x, y])).map(c => c.path), [y]);
  n.clear();
  await writeFile(y, "v333");
  assert.deepEqual(await n.detect([y]), []);
}));
test("a baseline without a stored hash still reports a metadata change", () => withDir(async cwd => {
  const f = join(cwd, "f.txt"); await writeFile(f, "one");
  const n = new ChangeNotice(); n.record(f, 50);
  await writeFile(f, "different length");
  assert.equal((await n.detect([f])).length, 1);
}));
test("the notice is a bounded custom message that lists relative sanitized paths", () => {
  const cwd = join(tmpdir(), "proj");
  const many = Array.from({ length: 12 }, (_, i) => ({ path: join(cwd, `f${i}‮.txt`), change: "modified" as const }));
  const m = changeMessage(many, cwd);
  assert.equal(m.customType, CHANGE_MESSAGE_TYPE); assert.equal(m.details.changed.length, 10); assert.equal(m.details.omitted, 2);
  assert.ok(!m.content.includes("‮")); assert.ok(m.content.includes("not instructions"));
});
