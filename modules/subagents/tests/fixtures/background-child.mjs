// Isolated real-CLI launcher: no provider credentials/settings inherited.
import { spawn } from "node:child_process";
import { join } from "node:path";
const [root, cli, ...args] = process.argv.slice(2);
const env = {};
for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PI_SUBAGENTS_GUARD"]) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { PI_CODING_AGENT_DIR: join(root, "config"), HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" });
const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: process.send ? ["inherit", "inherit", "inherit", "ipc"] : "inherit" });
if (process.send) {
  process.on("message", message => { if (child.connected) child.send(message, () => {}); });
  child.on("message", message => { if (process.connected) process.send(message, () => {}); });
}
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; if (process.connected) process.disconnect(); });
