import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedRecords } from "../src/provenance.js";
import { inventories, digest } from "./fixtures/inventory.js";

test("active inventories cover imports, adaptations, added, native and root without narrative hashes", () => {
  const { sources, adaptations, native } = inventories();
  Object.assign(adaptations, { historical: { path: "README.md", sha256: digest("wrong") } });
  const paths = new Set(["modules/fixture/a.ts", "tests/added.ts", "modules/native/index.ts", "README.md"]);
  const expected = expectedRecords(sources, adaptations, native, paths);
  assert.equal(expected.size, 4); assert.equal(expected.get("README.md")?.hash, digest("readme"));
  assert.equal(expected.get("modules/fixture/a.ts")?.hash, digest("current"));
  assert.equal(expectedRecords(sources, adaptations, native, new Set(["unknown"])).size, 0);
  // Real repository rootFiles repeats the active addedFiles smoke probe as a second equal assertion.
  adaptations.localSourceSuiteFinalIntegration.rootFiles.push({ path: "tests/added.ts", sha256: digest("added") });
  assert.equal(expectedRecords(sources, adaptations, native, paths).size, 4);
  adaptations.localSourceSuiteFinalIntegration.rootFiles.at(-1)!.sha256 = digest("conflicting");
  assert.throws(() => expectedRecords(sources, adaptations, native, paths), /duplicate-active-record/);
});
test("removals, origin identity, conflict, review and inventory bounds are strict", () => {
  const { sources, adaptations, native } = inventories();
  const removed = adaptations.files.pop()!;
  adaptations.removedFiles.push({ path: removed.path, originalSha256: removed.originalSha256, reason: "Removed" });
  assert.equal(expectedRecords(sources, adaptations, native, new Set([removed.path])).get(removed.path)?.absent, true);
  adaptations.files.push(removed);
  assert.throws(() => expectedRecords(sources, adaptations, native, new Set()), /invalid-import-adaptation/);
  adaptations.removedFiles.length = 0; removed.originalSha256 = digest("wrong");
  assert.throws(() => expectedRecords(sources, adaptations, native, new Set()), /origin-mismatch/);
  removed.originalSha256 = digest("original");
  Object.assign(removed, { historicalDeltaAudit: "unavailable" });
  assert.throws(() => expectedRecords(sources, adaptations, native, new Set()), /review-reason/);
  Object.assign(removed, { localSnapshotReview: "Current reviewed; earlier diff unavailable" });
  assert.equal(expectedRecords(sources, adaptations, native, new Set([removed.path])).get(removed.path)?.historical, true);
  assert.throws(() => expectedRecords(sources, adaptations, native, new Set(), 1), /inventory-budget/);
  adaptations.addedFiles.push({ ...adaptations.addedFiles[0] });
  assert.throws(() => expectedRecords(sources, adaptations, native, new Set()), /duplicate-active/);
});
