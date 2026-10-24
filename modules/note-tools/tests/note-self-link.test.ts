import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { noteTool } from "../extensions/note.ts";

const run = (cwd: string) => noteTool.execute("t", { type: "plan", content: "# Title\n" }, undefined, undefined, { cwd } as ExtensionToolContext);
async function workspace(t: TestContext, label: string) {
  const dir = await mkdtemp(join(tmpdir(), `pi-note-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// A note folder that is a link back to the workspace itself still leads INSIDE the workspace; only a link that leaves
// the workspace is an escape.
test("a note folder linked to the workspace root is inside the workspace and works", async (t) => {
  const cwd = await workspace(t, "self");
  symlinkSync(cwd, join(cwd, "plans"), "junction");
  const result = await run(cwd);
  const created = (await readdir(cwd)).filter((name) => /^PLAN-.*\.md$/.test(name));
  assert.equal(created.length, 1, "the note landed in the workspace root through the link");
  assert.match(String((result as { details?: { relativePath?: string } }).details?.relativePath ?? ""), /PLAN-.*\.md$/);
});

test("a note folder linked outside the workspace is still refused and nothing is written there", async (t) => {
  const cwd = await workspace(t, "escape");
  const outside = await workspace(t, "outside");
  symlinkSync(outside, join(cwd, "plans"), "junction");
  await assert.rejects(() => run(cwd), /NOTE_DIRECTORY_ESCAPE/);
  assert.deepEqual(await readdir(outside), []);
});
