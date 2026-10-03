import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { locateNpmCli, parsePackManifest, runCommand, runNpm } from "../scripts/test-process.mjs";
import { cleanupTestResources } from "../scripts/test-cleanup.mjs";

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("test process output separates stdout from diagnostics", async () => {
  const result = await runCommand("fixture stdout", process.execPath, ["-e", 'console.log("result"); console.error("diagnostic");'], { quiet: true, timeoutMs: 3000 });
  assert.equal(result.trim(), "result");
});

test("test process nonzero exit remains observable", async () => {
  await assert.rejects(() => runCommand("fixture exit", process.execPath, ["-e", 'console.error("fixture failure"); process.exit(3);'], { quiet: true, timeoutMs: 3000 }), /exited 3[\s\S]*fixture failure/);
});

test("test process timeout terminates a live root", { timeout: 15000 }, async () => {
  const started = performance.now();
  await assert.rejects(() => runCommand("fixture timeout", process.execPath, ["-e", 'setInterval(() => console.log("Fixture still running..."), 100);'], { quiet: true, timeoutMs: 500 }), /timed out/);
  assert.ok(performance.now() - started < 12000);
});

test("test process bounds output instead of accumulating indefinitely", { timeout: 15000 }, async () => {
  await assert.rejects(() => runCommand("fixture output limit", process.execPath, ["-e", 'process.stdout.write("x".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);'], { quiet: true, timeoutMs: 5000 }), /output exceeded 4 MiB/);
});

test("npm can be located without npm_execpath for direct node --test", async () => {
  const env = { ...process.env, npm_execpath: "" };
  const launches = [];
  const version = await runNpm("fixture direct npm", ["--version"], {
    env, quiet: true, timeoutMs: 10000,
    spawnProcess: (command, args, options) => { launches.push({ command, args }); return spawn(command, args, options); },
  });
  assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(launches.length, 1);
  const native = join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
  if (process.platform !== "win32" && locateNpmCli({ env: { PATH: "" } }) === native) {
    assert.deepEqual(launches[0], { command: process.execPath, args: [native, "--version"] });
  }
});

const nodePath = posix.join("/fixture", "node", "bin", "node");
const nativeCli = posix.join(posix.dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js");
const locateFixture = (files, options = {}) => locateNpmCli({
  execPath: nodePath, platform: "linux", env: { PATH: "" },
  exists: path => files.includes(path), realpath: path => path, ...options,
});

test("npm lookup prefers explicit npm_execpath and the current Linux installation over Windows PATH", () => {
  const explicit = posix.join("/fixture", "explicit", "npm-cli.js");
  const windowsCli = posix.join("/mnt/c/npm", "node_modules/npm/bin/npm-cli.js");
  const probes = [];
  assert.equal(locateFixture([explicit, nativeCli, windowsCli], { env: { npm_execpath: explicit, PATH: "/mnt/c/npm" } }), explicit);
  assert.equal(locateFixture([nativeCli, windowsCli], {
    env: { PATH: "/mnt/c/npm" },
    exists: path => { probes.push(path); return [nativeCli, windowsCli].includes(path); },
  }), nativeCli);
  assert.ok(!probes.some(path => path.startsWith("/mnt/c/")), "Native npm lookup must not probe slow Windows mounts");
});

test("POSIX npm lookup follows the first PATH npm symlink, not a later node_modules directory", () => {
  const executable = posix.join("/fixture/local/bin", "npm");
  const target = posix.join("/fixture/npm", "bin/npm-cli.js");
  const foreign = posix.join("/mnt/c/npm", "node_modules/npm/bin/npm-cli.js");
  const env = { PATH: "/fixture/local/bin:/mnt/c/npm" };
  assert.equal(locateFixture([executable, foreign], { env, realpath: () => target }), target);
  assert.equal(locateFixture([executable, foreign], { env }), undefined, "A wrapper must use normal npm executable lookup, not a foreign CLI");
  assert.equal(locateFixture([executable, foreign], { env, realpath: () => { throw new Error("broken link"); } }), undefined);
});

const windowsNode = String.raw`C:\Program Files\nodejs\node.exe`;
const locateWindowsFixture = (files, env, execPath = windowsNode) => locateFixture(files, { platform: "win32", execPath, env });

test("npm lookup retains Windows adjacent-node, explicit npm_execpath and quoted drive PATH layouts", () => {
  const adjacent = win32.join(win32.dirname(windowsNode), "node_modules/npm/bin/npm-cli.js");
  const pathDirectory = String.raw`D:\npm with spaces`;
  const pathCli = win32.join(pathDirectory, "node_modules/npm/bin/npm-cli.js");
  const explicit = String.raw`E:\selected npm\bin\npm-cli.js`;
  const env = { PATH: `"${pathDirectory}";C:\\other` };
  assert.equal(locateWindowsFixture([adjacent, pathCli], env), adjacent);
  assert.equal(locateWindowsFixture([pathCli], env), pathCli);
  assert.equal(locateWindowsFixture([explicit, adjacent, pathCli], { ...env, npm_execpath: explicit }), explicit);
  assert.equal(locateWindowsFixture([], env), undefined);
  assert.equal(locateFixture([]), undefined);
});

test("Windows npm lookup accepts Path-only and mixed-case keys in plain env objects", () => {
  const directory = String.raw`D:\npm with spaces`;
  const cli = win32.join(directory, "node_modules/npm/bin/npm-cli.js");
  for (const key of ["Path", "pAtH", "PATH", "path"]) {
    assert.equal(locateWindowsFixture([cli], { [key]: `"${directory}";C:\\missing` }), cli, key);
  }
  assert.equal(locateFixture([posix.join("/fixture/local/bin", "npm")], { env: { Path: "/fixture/local/bin" } }), undefined, "POSIX env lookup must remain case-sensitive");
});

test("Windows npm lookup resolves UNC installations and UNC PATH resources", () => {
  const uncNode = String.raw`\\server\share\node with spaces\node.exe`;
  const adjacent = win32.join(win32.dirname(uncNode), "node_modules/npm/bin/npm-cli.js");
  assert.equal(locateWindowsFixture([adjacent], {}, uncNode), adjacent);
  const directory = String.raw`\\server\tools\npm with spaces`;
  const cli = win32.join(directory, "node_modules/npm/bin/npm-cli.js");
  assert.equal(locateWindowsFixture([cli], { Path: `C:\\missing;"${directory}"` }), cli);
});

test("Windows duplicate PATH casing uses deterministic Node-compatible key precedence", () => {
  const firstDirectory = String.raw`D:\first npm`;
  const secondDirectory = String.raw`E:\second npm`;
  const firstCli = win32.join(firstDirectory, "node_modules/npm/bin/npm-cli.js");
  const secondCli = win32.join(secondDirectory, "node_modules/npm/bin/npm-cli.js");
  for (const env of [{ Path: secondDirectory, PATH: firstDirectory }, { PATH: firstDirectory, Path: secondDirectory }]) {
    assert.equal(locateWindowsFixture([firstCli, secondCli], env), firstCli);
  }
  assert.equal(locateWindowsFixture([firstCli], { PATH: "", Path: firstDirectory }), undefined, "An empty winning PATH must not silently fall back to another casing variant");
});

const packageIdentity = { name: "fixture-package", version: "1.0.0" };
const packFixture = () => ({
  ...packageIdentity, id: "fixture-package@1.0.0", filename: "fixture-package-1.0.0.tgz",
  size: 100, unpackedSize: 3, shasum: "a".repeat(40), integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  files: [{ path: "src/diff-worker.mjs", size: 3, mode: 0o644 }], entryCount: 1, bundled: [],
});
const packFormats = pack => [JSON.stringify([pack]), JSON.stringify({ [packageIdentity.name]: pack })];

test("npm pack normalizes legacy arrays and npm 12 keyed objects without losing resource metadata", () => {
  const pack = packFixture();
  for (const output of packFormats(pack)) assert.deepEqual(parsePackManifest(output, packageIdentity), pack);
  const scoped = { ...pack, name: "@fixture/package", id: "@fixture/package@1.0.0", filename: "fixture-package-1.0.0.tgz" };
  assert.deepEqual(parsePackManifest(JSON.stringify({ [scoped.name]: scoped }), scoped), scoped);
});

test("npm pack rejects malformed JSON, ambiguous packages and incorrect keyed identity", () => {
  const pack = packFixture();
  for (const output of ["not json", "null", "42", '"pack"', "[]", "{}", JSON.stringify([pack, pack]), JSON.stringify({ wrong: pack }), JSON.stringify({ [pack.name]: pack, extra: pack }), JSON.stringify({ [pack.name]: [pack] }), JSON.stringify([null])]) {
    assert.throws(() => parsePackManifest(output, packageIdentity), undefined, output);
  }
});

test("npm pack rejects invalid metadata and unsafe or inconsistent resource manifests in both formats", () => {
  const mutations = [
    pack => { pack.name = "other"; },
    pack => { pack.version = "2.0.0"; },
    pack => { pack.id = "other@1.0.0"; },
    pack => { pack.filename = "../fixture-package-1.0.0.tgz"; },
    pack => { pack.filename = "C:\\fixture-package-1.0.0.tgz"; },
    pack => { pack.size = 0; },
    pack => { pack.size = 1.5; },
    pack => { pack.unpackedSize = -1; },
    pack => { pack.shasum = "invalid"; },
    pack => { pack.integrity = "invalid"; },
    pack => { pack.files = {}; },
    pack => { pack.files = []; },
    pack => { pack.files[0] = null; },
    pack => { pack.files[0].size = -1; },
    pack => { pack.files[0].size = Number.MAX_SAFE_INTEGER + 1; },
    pack => { pack.files[0].mode = -1; },
    pack => { pack.entryCount = 2; },
    pack => { pack.unpackedSize = 4; },
    pack => { pack.bundled = ["dependency"]; },
    pack => { pack.files.push({ ...pack.files[0] }); pack.entryCount = 2; pack.unpackedSize = 6; },
    ...["", "/absolute", "../escape", "src/../escape", "./resource", "src//resource", "C:/escape", "src\\escape", "src/\x00resource"].map(path => pack => { pack.files[0].path = path; }),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const pack = packFixture(); mutate(pack);
    for (const output of packFormats(pack)) assert.throws(() => parsePackManifest(output, packageIdentity), undefined, `mutation ${index}: ${output}`);
  }
});

test("cleanup failure still runs later environment restoration and is not reported as complete", async () => {
  const ran = [];
  await assert.rejects(() => cleanupTestResources([
    ["simulated locked workspace", () => { ran.push("workspace"); throw Object.assign(new Error("locked"), { code: "EBUSY" }); }],
    ["restore environment", () => { ran.push("restore"); }],
  ]), error => error instanceof AggregateError && error.errors[0].cause.code === "EBUSY");
  assert.deepEqual(ran, ["workspace", "restore"]);
});

test("cleanup failure is reported without masking the primary test error", async t => {
  const warning = t.mock.method(console, "error", () => {});
  const primary = new Error("primary fixture error");
  let restored = false;
  await assert.rejects(async () => {
    try { throw primary; } finally {
      const result = await cleanupTestResources([
        ["workspace", () => { throw new Error("cleanup fixture error"); }],
        ["restore environment", () => { restored = true; }],
      ], primary);
      assert.equal(result.status, "incomplete");
    }
  }, error => error === primary);
  assert.equal(restored, true);
  assert.equal(warning.mock.calls.length, 1);
});
