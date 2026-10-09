import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
for (const mode of ["with-blackhole", "without-blackhole"]) for (const scenario of ["disabled-final", "disabled-tool", "low-pressure", "manual-projection", "alias", "auto", "native-tool", "reload-model", "overflow", "cancel"]) {
  it(`Pi-owned native offline lifecycle ${mode} ${scenario}`, async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const home = await mkdtemp(join(tmpdir(), "blackhole-pi-owned-"));
    const env: Record<string, string> = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name]!;
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true", PI_BLACKHOLE_COMPACTION: "auto" });
    try {
      console.log(`[pi-owned] Starting isolated native ${scenario} probe...`);
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/pi-owned-host.mjs", root, scenario, mode], { cwd: root, env });
      console.log(stdout); expect(stdout).toContain('"piOwnedContract":true'); expect(stdout).toContain('"externalProviderCalls":0');
    } catch (error) { const e = error as Error & { stdout?: string; stderr?: string }; console.log(e.stdout ?? ""); console.error(e.stderr ?? ""); throw error;
    } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}
