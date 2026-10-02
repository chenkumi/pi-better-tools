import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProcessExecutor } from "../../src/pi-process-executor.js";
import { nodeChildSpawner } from "../../src/runtime-deps.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const hostDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const cli = join(hostDist, "bundle", "cli.js");
const expectedPiVersion = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")).devDependencies["@earendil-works/pi-coding-agent"] as string;
const installedPiVersion = JSON.parse(await readFile(join(hostDist, "../package.json"), "utf8")).version as string;
expect(installedPiVersion).toBe(expectedPiVersion);
async function execute(prompt: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-cli-test-")); directories.push(directory);
  vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
  await writeFile(join(directory, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }));
  const executor = new PiProcessExecutor({ resolve: () => ({ command: process.execPath, version: installedPiVersion, args: [cli,
    "--no-extensions", "-e", resolve("tests/fixtures/offline-provider.ts"), "--no-skills", "--no-themes", "--no-prompt-templates", "--no-tools"] }) }, {
      spawn(request) {
        const env = Object.fromEntries(Object.entries(request.env ?? {}).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^PI_/i.test(key)));
        return nodeChildSpawner.spawn({ ...request, env: { ...env, HOME: directory, USERPROFILE: directory, APPDATA: directory,
          PI_AGENT_DIR: directory, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SCHEDULER_CHILD: "1" } });
      },
    }, undefined, directory);
  return executor.execute({ runId: "literal-test", schedule: { prompt, cwd: directory, execution: { provider: "scheduler-cli-test", model: "offline" } } });
}
describe(`real bundled Pi ${expectedPiVersion} CLI`, () => {
  it("treats leading @ as literal task text rather than reading a missing attachment", async () => {
    const { result } = await execute("@missing-file.txt run this literally");
    expect(result.exitCode).toBe(0); expect(result.piErrors).toEqual([]);
    expect(result.stdout).toContain("LITERAL:@missing-file.txt run this literally");
    expect(result.actualModel).toEqual({ provider: "scheduler-cli-test", model: "offline" });
  }, 30_000);
  it("supports a 32000-character Unicode prompt without Windows argv truncation", async () => {
    const prompt = "你".repeat(32_000); const { started, result } = await execute(prompt);
    expect(started.args.join(" ").length).toBeLessThan(3000); expect(started.args).not.toContain(prompt);
    expect(result.exitCode).toBe(0); expect(result.piErrors).toEqual([]);
    expect(result.actualModel?.model).toBe("offline");
  }, 30_000);
});
