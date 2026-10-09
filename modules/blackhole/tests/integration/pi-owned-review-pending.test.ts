import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
for (const scenario of ["peer-cancel", "append-entry-fault", "append-compaction-fault", "summary-abort", "success", "pre-refusal", "deletion-main-fault", "deletion-stale-fault", "stale-context", "branch-replacement", "session-replacement"]) it(`actual native pending commit/retry ${scenario}`, async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), home = await mkdtemp(join(tmpdir(), "bh-pending-review-"));
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true" });
  console.log(`[pi-owned-review] Starting isolated pending ${scenario} probe...`);
  try { const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/pi-owned-review-host.mjs", root, scenario], { cwd: root, env }); console.log(stdout); expect(stdout).toContain('"pendingCommitContract":true'); }
  catch (error) { const e = error as any; console.log(e.stdout ?? ""); console.error(e.stderr ?? ""); throw error; }
  finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
