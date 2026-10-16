import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, notePath, resolveInput, safeRelative, credentialPath } from "../src/paths.js";

test("normalization handles relative, file URL, literal @ and convenience @", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "file-audit-paths-"));
  try {
    await writeFile(join(cwd, "a.ts"), "a"); await writeFile(join(cwd, "@a.ts"), "b");
    assert.equal(canonicalPath("a.ts", cwd), canonicalPath(pathToFileURL(join(cwd, "a.ts")).href, cwd));
    assert.equal(resolveInput("@a.ts", cwd), join(cwd, "@a.ts"));
    await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src/a.ts"), "a");
    assert.equal(resolveInput("@src/a.ts", cwd), join(cwd, "src/a.ts"));
    if (process.platform === "win32") assert.equal(resolveInput("/mnt/d/a.ts", cwd), "D:\\a.ts");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("note uses only valid structured result paths, never content text", () => {
  assert.equal(notePath({ details: { relativePath: "plan/PLAN-1.md" } }), "plan/PLAN-1.md");
  assert.equal(notePath({ structuredContent: { relativePath: "plan/x.md" }, details: { relativePath: "plan/x.md" } }), "plan/x.md");
  for (const result of [{ content: [{ text: "Saved note: plan/x.md" }] }, { details: { relativePath: "../x" } },
    { details: {}, structuredContent: { relativePath: "plan/x" } },
    { details: { relativePath: "plan/x" }, structuredContent: { relativePath: "plan/y" } }]) assert.throws(() => notePath(result));
  for (const path of ["C:\\outside", "/outside", "../x", "plan/../x", "plan//x", "file:///x"]) assert.equal(safeRelative(path), false);
  for (const path of [".env", "src/.env.local", "x/auth.json", ".pi/a", ".git/a"]) assert.equal(credentialPath(path), true);
});
