import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OUTPUT_RETENTION_MS, sweepOldOutputs } from "../src/index.js";

test("removes only saved outputs older than the retention period", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-sweep-"));
  const now = Date.now();
  const old = join(directory, "11111111-1111-4111-8111-111111111111.json");
  const fresh = join(directory, "22222222-2222-4222-8222-222222222222.json");
  const foreign = join(directory, "keep-me.json");
  for (const path of [old, fresh, foreign]) writeFileSync(path, "{}");
  const stale = (now - OUTPUT_RETENTION_MS - 60_000) / 1000;
  utimesSync(old, stale, stale);
  utimesSync(foreign, stale, stale);

  await sweepOldOutputs(directory, now);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(foreign), true);
  await sweepOldOutputs(join(directory, "missing"), now); // never throws
});
