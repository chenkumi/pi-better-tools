import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Real-host integration belongs to Blackhole's existing Vitest glob; no root runner patch.
it.each(["default", "append"])("Pi 1.1.0 %s native compact/persist/resume preserves notification evidence without provider calls", async summaryMode => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "blackhole-notification-host-"));
  const env: Record<string, string> = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true" });
  try {
    console.log("[notification-evidence] Starting isolated Pi 1.1.0 compact/resume/recall probe...");
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/notification-evidence-host.mjs", root, summaryMode], { cwd: root, env });
    console.log(stdout);
    if (summaryMode === "append") expect(stdout).toContain('"appendChain":true');
    expect(stdout).toContain('"nativeCompact":true'); expect(stdout).toContain('"resumed":true'); expect(stdout).toContain('"recall":true'); expect(stdout).toContain('"providerCalls":0');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
