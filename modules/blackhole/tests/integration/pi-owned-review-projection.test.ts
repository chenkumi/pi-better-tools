import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
for (const scenario of ["boundary-null", "display-null", "display-replaced", "display-normal", "memory-null", "memory-replaced", "memory-normal", "memory-checkpoint", "memory-empty", "settings-session"]) it(`actual native projection/persistence ${scenario}`, async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), home = await mkdtemp(join(tmpdir(), "bh-projection-review-"));
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true" });
  console.log(`[pi-owned-review] Starting isolated projection ${scenario} probe...`);
  try { const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/pi-owned-review-projection-host.mjs", root, scenario], { cwd: root, env, timeout: 60000 }); console.log(stdout); expect(stdout).toContain('"projectionContract":true'); }
  catch (error) { const e = error as any; console.log(e.stdout ?? ""); console.error(e.stderr ?? ""); throw error; }
  finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 65000);
