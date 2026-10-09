import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const variant of ["virtual-selected", "delegate-switch"]) {
it(`Pi 1.1.0 native callback replay diagnostic: ${variant}`, async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "blackhole-native-chain-"));
  const env: Record<string, string> = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true" });
  try {
    console.log(`[before-request] Starting isolated Pi 1.1.0 ${variant} threshold-cancellation diagnostic...`);
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/before-request-native-chain-host.mjs", root, variant], { cwd: root, env });
    console.log(stdout);
    expect(stdout).toContain('"nativeChainReplayReproduced":true');
    expect(stdout).toContain('"providerInvocations":0');
    expect(stdout).toContain('"previousCalls":2');
    expect(stdout).toContain('"privatePatches":0');
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    console.log(result.stdout ?? ""); console.error(result.stderr ?? ""); throw error;
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
}
