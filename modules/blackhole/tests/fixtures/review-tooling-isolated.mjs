// Retained review runner: empty credentials and owned HOME/agent/temp/workspace.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isolatedEnv } from "../../../../tests/helpers/environment.mjs";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const owned = await mkdtemp(join(tmpdir(), "bh-review-tooling-"));
const home = join(owned, "home"), temp = join(owned, "temp"), workspace = join(owned, "workspace");
try {
  const env = { ...isolatedEnv(home), TEMP: temp, TMP: temp, TMPDIR: temp };
  for (const dir of [home, temp, workspace, env.PI_CODING_AGENT_DIR, join(owned, "store")]) await mkdir(dir, { recursive: true });
  console.log("[review-tooling] Starting isolated helper event/process contracts...");
  const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), join(root, "modules/file-tools/tests/test-tooling.test.mjs")], { cwd: workspace, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  process.exitCode = code ?? 1;
} finally {
  console.log("[review-tooling] Cleaning only owned fixture resources...");
  await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
