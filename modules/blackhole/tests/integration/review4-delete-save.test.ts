import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
for (const scope of ["global", "project"]) for (const action of ["save", "edit-save", "cancel", "refusal", "unlink-fault", "write-fault"]) it(`W3 actual Pi ${scope}:${action}`, async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), home = await mkdtemp(join(tmpdir(), "bh-review4-delete-save-"));
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), PI_CODING_AGENT_DIR: home, PI_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true" });
  console.log(`Starting actual Pi review4 ${scope}:${action}...`);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/review4-delete-save-host.mjs", root, `${scope}:${action}`], { cwd: root, env, timeout: 60000 });
    const summary = stdout.split("\n").filter(line => line.includes('"deleteSaveContract"')); console.log(summary.join("\n"));
    expect(summary.join("\n")).toContain('"deleteSaveContract":true');
  } catch (error) { console.log((error as any).stdout ?? ""); console.error((error as any).stderr ?? ""); throw error; }
  finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 65000);
