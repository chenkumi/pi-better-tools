import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OUTPUT_RETENTION_MS, sweepOldOutputs } from "../src/index.js";

// The sweep used to look at only the first 256 directory entries, so an expired file listed after them lived forever.
const uuid = (n: number, tail = "4111-8111-111111111111") => `${n.toString(16).padStart(8, "0")}-1111-${tail}`.slice(0, 36);
function populate(fresh: number) {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-sweep-large-"));
  for (let i = 0; i < fresh; i++) writeFileSync(join(directory, `${uuid(i)}.json`), "{}");
  const old = join(directory, `ffffffff-1111-4111-8111-111111111111.json`); // sorts after every fresh file
  writeFileSync(old, "{}");
  const now = Date.now(), stale = (now - OUTPUT_RETENTION_MS - 60_000) / 1000;
  utimesSync(old, stale, stale);
  return { directory, old, now };
}

test("an expired output listed after hundreds of fresh ones is still removed", async () => {
  const { directory, old, now } = populate(300);
  await sweepOldOutputs(directory, now);
  assert.equal(existsSync(old), false);
});

test("beyond the per-call work bound the start rotates, so no expired file is skipped forever", async () => {
  const { directory, old, now } = populate(2200);
  await sweepOldOutputs(directory, now, 0); // starts at the first entry: stays inside the bound and misses the last one
  assert.equal(existsSync(old), true, "the per-call work is bounded");
  await sweepOldOutputs(directory, now, 0.99); // a later call starting elsewhere reaches it
  assert.equal(existsSync(old), false);
});
