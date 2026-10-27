import assert from "node:assert/strict";
import test from "node:test";
import { findNodeExecutable, isSupportedNodeVersion, SqliteStartupError, type NodeLookup } from "../src/node-runtime.js";

function lookup(overrides: Partial<NodeLookup> & { files?: string[]; versionsByPath?: Record<string, string> } = {}): NodeLookup {
  const { files = [], versionsByPath = {}, ...rest } = overrides;
  return {
    platform: "win32",
    env: {},
    execPath: "C:\\Tools\\pi-bolt.exe",
    versions: { bun: "1.4.3", node: "24.3.0" },
    isFile: path => files.includes(path),
    probe: async path => versionsByPath[path],
    ...rest,
  };
}

test("supported versions follow the package engines range", () => {
  for (const ok of ["22.22.2", "22.23.0", "24.15.0", "24.16.1", "26.0.0", "26.8.1"]) assert.equal(isSupportedNodeVersion(ok), true, ok);
  for (const bad of ["22.22.1", "22.5.0", "23.0.0", "24.14.9", "25.1.0", "20.0.0", ""]) assert.equal(isSupportedNodeVersion(bad), false, bad);
});

test("a Node host runs the worker itself", async () => {
  const host = lookup({ execPath: "/usr/local/bin/node", platform: "linux", versions: { node: "24.15.0" } });
  assert.equal(await findNodeExecutable(host), "/usr/local/bin/node");
});

test("a Node host that is too old is refused instead of searching PATH", async () => {
  const host = lookup({ execPath: "C:\\nodejs\\node.exe", versions: { node: "20.1.0" } });
  await assert.rejects(findNodeExecutable(host), SqliteStartupError);
});

test("a Bun host finds node.exe on a Windows PATH, case-insensitively, ignoring quotes and blanks", async () => {
  const exe = "C:\\Program Files\\nodejs\\node.exe";
  const host = lookup({ env: { Path: ';"C:\\Program Files\\nodejs";C:\\other' }, files: [exe], versionsByPath: { [exe]: "26.8.1" } });
  assert.equal(await findNodeExecutable(host), exe);
});

test("a Bun host finds node on a POSIX PATH and skips unsupported builds", async () => {
  const old = "/old/node";
  const good = "/new/node";
  const host = lookup({ platform: "linux", execPath: "/opt/pi/pi-bolt", env: { PATH: "/old:/new" }, files: [old, good], versionsByPath: { [old]: "18.0.0", [good]: "22.22.2" } });
  assert.equal(await findNodeExecutable(host), good);
});

test("PI_SQLITE_NODE overrides PATH and never silently falls back", async () => {
  const exe = "/custom/node";
  const ok = lookup({ platform: "linux", execPath: "/opt/pi/pi-bolt", env: { PI_SQLITE_NODE: exe, PATH: "/new" }, files: [exe, "/new/node"], versionsByPath: { [exe]: "24.15.0", "/new/node": "26.0.0" } });
  assert.equal(await findNodeExecutable(ok), exe);
  const broken = lookup({ platform: "linux", execPath: "/opt/pi/pi-bolt", env: { PI_SQLITE_NODE: "/missing/node", PATH: "/new" }, files: ["/new/node"], versionsByPath: { "/new/node": "26.0.0" } });
  await assert.rejects(findNodeExecutable(broken), /missing/);
});

test("no usable Node gives an agent-safe message and a human message naming the override", async () => {
  const host = lookup({ platform: "darwin", execPath: "/opt/pi/pi-bolt", env: { PATH: "" } });
  await assert.rejects(findNodeExecutable(host), (error: unknown) => {
    assert.ok(error instanceof SqliteStartupError);
    assert.doesNotMatch(error.message, /PI_SQLITE_NODE/);
    assert.match(error.humanMessage, /PI_SQLITE_NODE/);
    return true;
  });
});
