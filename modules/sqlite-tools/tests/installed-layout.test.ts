import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pi loads the extension's TypeScript itself, but the SQLite child is started by plain Node, which refuses to run
// TypeScript from inside node_modules. Everything the child imports must therefore be plain JavaScript.
test("the SQLite child process starts from an installed node_modules layout", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-sqlite-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules", "pi-better-tools", "modules", "sqlite-tools", "src");
  mkdirSync(installed, { recursive: true });
  for (const name of ["sqlite-process.mjs", "sqlite-core.mjs", "ipc-codec.mjs"]) copyFileSync(new URL(`../src/${name}`, import.meta.url), join(installed, name));

  const child = fork(join(installed, "sqlite-process.mjs"), [], { execArgv: [], serialization: "json", stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const outcome = await new Promise<string>((resolve) => {
    child.once("message", (message) => resolve(JSON.stringify(message)));
    child.once("close", (code) => resolve(`exited ${code}: ${stderr.split("\n").find((line) => /Error|ERR_/.test(line)) ?? ""}`));
  });
  child.kill("SIGKILL");
  assert.equal(outcome, JSON.stringify({ ready: true }));
});
