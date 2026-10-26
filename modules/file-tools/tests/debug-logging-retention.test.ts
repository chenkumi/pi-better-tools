import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_LOG_DAYS, MAX_LOG_DAY_BYTES, writeFileToolFailureLog } from "../src/debug-logging.js";

test("failure log keeps only the newest day files and stops appending at the daily cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-log-retention-"));
  try {
    for (let day = 1; day <= 9; day++) await writeFile(join(dir, `2025-01-0${day}.jsonl`), "{}\n");
    await writeFile(join(dir, "other.txt"), "keep");
    await writeFileToolFailureLog("read", "c1", { path: "a" }, new Error("boom"), dir);
    const names = (await readdir(dir)).sort();
    const days = names.filter((name) => name.endsWith(".jsonl"));
    assert.equal(days.length, MAX_LOG_DAYS);
    assert.ok(!days.includes("2025-01-01.jsonl") && days.includes("2025-01-09.jsonl"));
    assert.ok(names.includes("other.txt"));

    const today = days.find((name) => !name.startsWith("2025-"))!;
    await writeFile(join(dir, today), "x".repeat(MAX_LOG_DAY_BYTES));
    await writeFileToolFailureLog("read", "c2", { path: "a" }, new Error("boom"), dir);
    assert.equal((await stat(join(dir, today))).size, MAX_LOG_DAY_BYTES);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
