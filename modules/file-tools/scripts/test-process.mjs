import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// Test tooling only: stop the process group/tree on timeout, and bound the wait
// for termination too. Pipe closure alone cannot establish Windows tree cleanup.
export async function runCommand(label, command, args, { cwd, env = process.env, timeoutMs = 180000, quiet = false, terminationGraceMs = 8000, spawnProcess = spawn } = {}) {
  console.log(`Starting ${label}...`);
  const started = Date.now();
  const child = spawnProcess(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let output = "";
  let stdout = "";
  let failure;
  let stopped = false;
  let finished = false;
  let terminationDeadline;
  const killers = [];
  let rejectCompletion;
  const completed = new Promise((resolve, reject) => {
    rejectCompletion = reject;
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
  const recoverWindowsDescendants = () => {
    if (finished) return;
    // A root may already have exited while a descendant still holds the pipe.
    // Win32_Process retains ParentProcessId; collect recent descendants before
    // stopping them. Do not target unrelated processes created before this run.
    const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $ids=@(${child.pid}); $found=@(); $since=[DateTimeOffset]::FromUnixTimeMilliseconds(${started - 1000}).UtcDateTime; do { $next=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $found -notcontains [int]$_.ProcessId -and $_.CreationDate.ToUniversalTime() -ge $since } | ForEach-Object { [int]$_.ProcessId }); $found+= $next; $ids=$next } while($ids.Count -gt 0); [array]::Reverse($found); foreach($id in $found) { if(Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force } }`;
    const killer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
    killers.push(killer);
    killer.on("error", () => { failure.message += "; descendant cleanup could not start"; });
    killer.on("exit", code => { if (code !== 0) failure.message += "; descendant cleanup failed"; });
  };
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    failure = new Error(`${label}: ${reason}`);
    // Never wait forever for close when descendants keep stdout/stderr open.
    terminationDeadline = setTimeout(() => {
      failure.message += "; termination could not be confirmed within the grace period";
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      for (const killer of killers) { killer.kill(); killer.unref(); }
      rejectCompletion(failure);
    }, terminationGraceMs);
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      killers.push(killer);
      killer.on("error", recoverWindowsDescendants);
      killer.on("exit", code => { if (code !== 0) recoverWindowsDescendants(); });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  };
  const consume = (chunk, stream) => {
    if (!quiet) stream.write(chunk);
    if (output.length + chunk.length > 4 * 1024 * 1024) stop("output exceeded 4 MiB");
    else {
      const text = chunk.toString("utf8"); output += text;
      if (stream === process.stdout) stdout += text;
    }
  };
  child.stdout.on("data", chunk => consume(chunk, process.stdout));
  child.stderr.on("data", chunk => consume(chunk, process.stderr));
  const progress = setInterval(() => console.log(`${label} still running (${Math.round((Date.now() - started) / 1000)}s)...`), 10000);
  const watchdog = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    const code = await completed;
    if (failure) throw failure;
    if (code !== 0) throw new Error(`${label} exited ${code}\n${output.slice(-12000)}`);
    console.log(`${label} complete.`);
    return stdout;
  } finally {
    finished = true;
    clearInterval(progress); clearTimeout(watchdog); clearTimeout(terminationDeadline);
    for (const killer of killers) {
      if (killer.exitCode === null && killer.signalCode === null) { killer.kill(); killer.unref(); }
    }
  }
}

export function runNpm(label, args, options) {
  // Avoid cmd string interpolation, including direct node --test on Windows.
  const candidates = [process.env.npm_execpath, ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)].map(path => join(path.replace(/^"|"$/g, ""), "node_modules/npm/bin/npm-cli.js"))];
  const cli = candidates.find(path => path && existsSync(path));
  if (cli) return runCommand(label, process.execPath, [cli, ...args], options);
  if (process.platform !== "win32") return runCommand(label, "npm", args, options);
  throw new Error("Cannot locate npm-cli.js; invoke this test using npm run test:integration");
}
