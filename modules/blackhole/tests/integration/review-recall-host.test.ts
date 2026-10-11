import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { vccRecall } from "../../src/tools/recall.js";
import { loadAllMessages } from "../../src/core/load-messages.js";

it("R15/R16 Pi 1.1 persisted resetLeaf, cache and bounded inspection retain authoritative #N", async () => {
  expect(process.env.PI_BLACKHOLE_PASSIVE).toBe("true");
  const root = mkdtempSync(join(tmpdir(), "bh-review-native-"));
  const workspace = join(root, "workspace"); const store = join(root, "store");
  mkdirSync(workspace); mkdirSync(store);
  try {
    console.log("[review-recall] Testing isolated Pi 1.1 persisted session without providers...");
    const manager = SessionManager.create(workspace, store);
    manager.appendMessage({ role: "user", content: "abandoned old branch", timestamp: 0 });
    const ctx: any = { cwd: workspace, sessionManager: manager };
    const all = await vccRecall({ query: "abandoned", scope: "all" }, ctx);
    expect(all.content[0].text).toContain("#0");
    manager.resetLeaf();
    const empty = await vccRecall({ query: "abandoned" }, ctx);
    expect(empty.content[0].text).toContain("No matches");
    expect(empty.content[0].text).not.toContain("#0");
    manager.appendMessage({ role: "user", content: "active selected branch", timestamp: 1 });
    const selected = await vccRecall({ expand: [1] }, ctx);
    expect(selected.content[0].text).toContain("#1");
    expect(selected.content[0].text).not.toContain("abandoned old branch");
    manager.appendMessage({ role: "user", content: "x".repeat(1024 * 1024 + 1), timestamp: 2 });
    manager.appendMessage({ role: "user", content: "unknown tail", timestamp: 3 });
    const incomplete: any = await vccRecall({ query: "unknown", scope: "all" }, ctx);
    expect(incomplete.details.historyInspection.incomplete).toBe(true);
    expect(incomplete.content[0].text).toContain("History inspection incomplete");
    expect(incomplete.content[0].text).not.toContain("#2");
    expect(incomplete.content[0].text).not.toContain("#3");
    const loaded = loadAllMessages(manager.getSessionFile()!, false);
    expect(loaded.rendered.map(entry => entry.index)).toEqual([0, 1]);
    expect(loaded.scanStats.maxBufferedBytes).toBeLessThanOrEqual(1024 * 1024);
    console.log("[review-recall] Persisted branch/cache/bounds verified; providerCalls=0.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
