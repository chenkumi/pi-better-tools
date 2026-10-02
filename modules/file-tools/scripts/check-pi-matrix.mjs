import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./test-process.mjs";
import { cleanupTestResources } from "./test-cleanup.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const supported = ["0.86.1", "0.99.1"];
const versions = process.argv.length > 2 ? process.argv.slice(2) : supported;
assert.ok(versions.length > 0 && versions.every(version => supported.includes(version)), "Choose Pi 0.86.1 and/or 0.99.1");
const evidence = process.env.PI_FILE_TOOLS_EVIDENCE ? resolve(process.env.PI_FILE_TOOLS_EVIDENCE) : undefined;
if (evidence) await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "pi-file-tools-matrix-"));
const results = [];
let failed = false;
let primaryError;
const startedAt = new Date().toISOString();
console.log(`Preparing isolated Pi version matrix in ${root}`);
try {
  for (const version of versions) {
    const cwd = join(root, version);
    await mkdir(cwd);
    // Use the current lockfile as the resolution seed. Only the sandbox's two
    // exact development versions change; original dependencies stay untouched.
    for (const path of ["src", "extensions", "tests", "scripts", "README.md", "package.json", "package-lock.json", "tsconfig.json"]) {
      await cp(join(project, path), join(cwd, path), { recursive: true });
    }
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    manifest.devDependencies["@earendil-works/pi-coding-agent"] = version;
    manifest.devDependencies["@earendil-works/pi-tui"] = version;
    await writeFile(join(cwd, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "isolated-agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
    for (const [name, args] of [["install", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]], ["check", ["run", "check"]], ["dependencies", ["ls", "--depth=0"]]]) {
      const started = Date.now();
      try {
        const output = await runNpm(`Pi ${version} ${name}`, args, { cwd, env, timeoutMs: name === "install" ? 240000 : 180000 });
        results.push({ version, stage: name, status: "PASS", elapsedMs: Date.now() - started });
        if (evidence) await writeFile(join(evidence, `matrix-${version}-${name}.txt`), output);
      } catch (error) {
        results.push({ version, stage: name, status: "FAIL", elapsedMs: Date.now() - started, error: String(error) });
        if (evidence) await writeFile(join(evidence, `matrix-${version}-${name}.txt`), String(error));
        console.error(error);
        failed = true;
        break;
      }
    }
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  console.log("Removing isolated Pi matrix workspaces...");
  const summary = { startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform, versions, results, cleanup: "incomplete", sandbox: root };
  const cleanup = await cleanupTestResources([
    ["matrix workspace", async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      summary.cleanup = "complete";
    }],
    ["matrix evidence", async () => {
      if (evidence) await writeFile(join(evidence, "matrix-summary.json"), JSON.stringify(summary, null, 2) + "\n");
      console.log(JSON.stringify(summary, null, 2));
    }],
  ], primaryError);
  console.log(`Pi matrix cleanup ${cleanup.status}.`);
}
if (failed) process.exitCode = 1;
