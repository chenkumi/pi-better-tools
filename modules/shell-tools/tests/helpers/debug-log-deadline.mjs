import { pbkdf2 } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFailureDebugLog } from "../../src/debug-log.mjs";

const homeDir = process.argv[2];
if (!homeDir) throw new Error("An isolated test home directory is required");
const heartbeat = setInterval(() => console.log("Filesystem deadline probe in progress..."), 1000);
try {
  console.log("Starting isolated filesystem-threadpool saturation probe...");
  let workFinished = false;
  // The parent sets UV_THREADPOOL_SIZE=1 before this process starts. Occupy
  // that worker so the logger's filesystem request cannot complete immediately.
  const busy = new Promise((resolve, reject) => {
    pbkdf2("test", "test", 5_000_000, 32, "sha512", (error) => {
      workFinished = true;
      if (error) reject(error); else resolve();
    });
  });
  const start = performance.now();
  const result = await writeFailureDebugLog({
    tool: "bash", toolCallId: "deadline-test", elapsedMs: 0,
    input: { command: "exit 7" }, failure: { kind: "exception", error: new Error("test") },
  }, { homeDir, maxWaitMs: 100 });
  const elapsedMs = performance.now() - start;
  const returnedBeforeWorkFinished = !workFinished;
  await busy;
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(JSON.stringify({
    result: result ?? null, elapsedMs, returnedBeforeWorkFinished,
    logsExist: fs.existsSync(path.join(homeDir, ".pi", "logs")),
  }));
} finally {
  clearInterval(heartbeat);
}
