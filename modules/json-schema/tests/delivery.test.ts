import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/delivery.ts";

test("writes 2-space JSON with a trailing newline and replaces an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "json-delivery-"));
  try {
    const target = join(dir, "out", "result.json");
    await writeJsonFile(target, { a: 1, b: ["x"] });
    assert.equal(await readFile(target, "utf8"), '{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
    await writeJsonFile(target, { a: 2 });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { a: 2 });
    assert.deepEqual((await readdir(join(dir, "out"))).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed write keeps the previous file and leaves no temporary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "json-delivery-"));
  try {
    const target = join(dir, "result.json");
    await writeFile(target, "OLD\n");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(writeJsonFile(target, circular));
    assert.equal(await readFile(target, "utf8"), "OLD\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
