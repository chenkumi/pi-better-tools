import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Shared offline actual-CLI launcher. All callers own isolated cwd/config and finally cleanup. */
export async function invokeCli(cli: string, args: string[], cwd: string, env: Record<string, string | undefined>, capture?: string, stdoutLimit = 64 * 1024 * 1024) {
	if (capture) { await mkdir(capture, { recursive: true }); await writeFile(join(capture, "argv.json"), JSON.stringify({ executable: process.execPath, args: [cli, ...args], cwd }, null, 2)); }
	console.log(`[progress] Starting real CLI invocation in ${cwd}`);
	const actual = await new Promise<{ code: number | null; pid?: number; stdout: string; stderr: string }>((done, reject) => {
		const proc = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [], stderr: Buffer[] = []; let outBytes = 0, errBytes = 0, failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
		const stop = (message: string) => { if (failure) return; failure = new Error(message); proc.kill("SIGTERM"); killTimer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); }, 5000); };
		const deadline = setTimeout(() => stop("CLI integration exceeded 60 seconds"), 60000);
		const heartbeat = setInterval(() => console.log(`[progress] CLI pid=${proc.pid}: ${outBytes} stdout bytes`), 10000);
		const cleanup = () => { clearTimeout(deadline); clearInterval(heartbeat); if (killTimer) clearTimeout(killTimer); };
		proc.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > stdoutLimit) stop("CLI stdout capture capacity exceeded"); else stdout.push(chunk); });
		proc.stderr.on("data", (chunk: Buffer) => { const keep = chunk.subarray(0, Math.max(0, 64 * 1024 - errBytes)); errBytes += keep.length; if (keep.length) stderr.push(keep); });
		proc.stdout.on("error", e => stop(String(e))); proc.stderr.on("error", e => stop(String(e)));
		proc.on("error", e => { cleanup(); reject(e); });
		proc.on("close", code => { cleanup(); if (failure) reject(failure); else done({ code, pid: proc.pid, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
	});
	if (capture) { await writeFile(join(capture, "events.jsonl"), actual.stdout); await writeFile(join(capture, "stderr.txt"), actual.stderr); await writeFile(join(capture, "exit.json"), JSON.stringify({ code: actual.code, pid: actual.pid })); }
	return actual;
}
export function isolatedEnv(root: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
	return { ...env, PI_CODING_AGENT_DIR: join(root, "config"), HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
}
