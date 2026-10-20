// Real-process helper for lock tests: `hold` keeps the storage lock until killed (or `ms` elapsed); `add` appends jobs.
import * as fs from "node:fs";
import { CronStorage } from "../../src/storage.js";

const [op, cwd, a, b] = process.argv.slice(2);
CronStorage.lockWaitMs = Number(process.env.LOCK_CHILD_WAIT_MS ?? 1500);
const storage = new CronStorage(cwd);
const job = (id: string) => ({ id, name: id, schedule: "5m", prompt: "p", enabled: true, type: "interval" as const, intervalMs: 300000, createdAt: "", runCount: 0 });
try {
  if (op === "hold") {
    storage.addJob(job("seed")); // hold must not race creation: seed first, then hold inside a locked mutation
    storage.updateJobWith("seed", () => {
      fs.writeFileSync(a, "ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(b ?? 600000));
      return {};
    });
  } else if (op === "add") {
    const count = Number(b ?? 1);
    for (let i = 0; i < count; i++) storage.addJob(job(`${a}-${i}`));
  }
  console.log("OK");
} catch (error) {
  console.log("FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
