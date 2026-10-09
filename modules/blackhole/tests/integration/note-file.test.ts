import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

it("Pi 1.1.0 actual Note/File producers + native compact/resume keep lists and stored drilldown without changing fixture bytes/hashes", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "blackhole-note-file-host-"));
  const env: Record<string, string> = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_BLACKHOLE_PASSIVE: "true" });
  try {
    console.log("[note-file] Starting isolated actual producers + Pi 1.1.0 compact/resume/recall probe...");
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "modules/blackhole/tests/fixtures/note-file-host.mjs", root], { cwd: root, env });
    console.log(stdout);
    for (const key of ["producerExecuted", "nativeCompact", "resumed", "fileLists", "malformedFileAttemptsExcluded", "drilldown", "originalArguments", "fixtureBytesAndHashesUnchanged"]) expect(stdout).toContain(`"${key}":true`);
    expect(stdout).toContain('"providerCalls":0');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
