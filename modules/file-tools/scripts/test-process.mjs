import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

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

export function locateNpmCli({ env = process.env, execPath = process.execPath, platform = process.platform, exists = existsSync, realpath = realpathSync } = {}) {
  if (env.npm_execpath && exists(env.npm_execpath)) return env.npm_execpath;
  const paths = platform === "win32" ? win32 : posix;
  const nodeDirectory = paths.dirname(execPath);
  // Linux/macOS (including nvm) put npm under lib/, while Windows puts it
  // beside node.exe. Check the current Node installation before inherited PATH.
  for (const path of [paths.join(nodeDirectory, "node_modules/npm/bin/npm-cli.js"), paths.join(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js")]) {
    if (exists(path)) return path;
  }
  // Plain options.env objects are case-sensitive even on Windows. Match Node's
  // deterministic, lexicographically first key when casing variants coexist.
  const pathKey = platform === "win32" ? Object.keys(env).sort().find(key => key.toLowerCase() === "path") : "PATH";
  const pathEntries = (env[pathKey] ?? "").split(paths.delimiter).map(path => path.replace(/^"|"$/g, ""));
  if (platform === "win32") {
    return pathEntries.map(path => paths.join(path, "node_modules/npm/bin/npm-cli.js")).find(exists);
  }
  // Respect the first actual npm executable on POSIX. Blindly probing every
  // PATH entry's node_modules can pick Windows npm across a slow WSL mount.
  const executable = pathEntries.map(path => paths.join(path, "npm")).find(exists);
  if (executable) {
    try {
      const target = realpath(executable);
      if (paths.basename(target) === "npm-cli.js") return target;
    } catch { /* Let normal executable lookup report a broken link/wrapper. */ }
  }
}

export function runNpm(label, args, options = {}) {
  // Avoid cmd string interpolation, including direct node --test on Windows.
  const cli = locateNpmCli({ env: options.env ?? process.env });
  if (cli) return runCommand(label, process.execPath, [cli, ...args], options);
  if (process.platform !== "win32") return runCommand(label, "npm", args, options);
  throw new Error("Cannot locate npm-cli.js; invoke this test using npm run test:integration");
}

export function parsePackManifest(output, { name, version }) {
  assert.ok(typeof name === "string" && name.length > 0 && typeof version === "string" && version.length > 0, "expected package identity is required");
  const data = JSON.parse(output);
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  let pack;
  if (Array.isArray(data)) {
    assert.equal(data.length, 1, "npm pack must return exactly one package");
    [pack] = data;
  } else {
    assert.ok(record(data), "npm pack JSON must be an array or a package-name keyed object");
    assert.deepEqual(Object.keys(data), [name], "npm pack object must contain only the expected package name");
    pack = data[name];
  }
  assert.ok(record(pack), "npm pack manifest must be an object");
  assert.equal(pack.name, name, "unexpected packed package name");
  assert.equal(pack.version, version, "unexpected packed package version");
  assert.equal(pack.id, `${name}@${version}`, "unexpected packed package id");
  assert.equal(pack.filename, `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`, "unexpected or unsafe tarball filename");
  assert.ok(!/[\\/\x00]/.test(pack.filename), "unsafe tarball filename");
  assert.ok(Number.isSafeInteger(pack.size) && pack.size > 0, "invalid tarball size");
  assert.ok(Number.isSafeInteger(pack.unpackedSize) && pack.unpackedSize > 0, "invalid unpacked size");
  assert.match(pack.shasum ?? "", /^[a-f0-9]{40}$/, "invalid tarball shasum");
  assert.match(pack.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, "invalid tarball integrity");
  assert.ok(Array.isArray(pack.files) && pack.files.length > 0, "npm pack files must be a nonempty array");
  assert.equal(pack.entryCount, pack.files.length, "npm pack entry count does not match files");
  assert.ok(Array.isArray(pack.bundled) && pack.bundled.length === 0, "unexpected bundled dependencies");
  const paths = new Set();
  let bytes = 0;
  for (const file of pack.files) {
    assert.ok(record(file), "npm pack file must be an object");
    assert.ok(typeof file.path === "string" && file.path.length > 0 && !/[\\:\x00]/.test(file.path) && file.path.split("/").every(part => part && part !== "." && part !== ".."), "unsafe package resource path");
    assert.ok(!paths.has(file.path), `duplicate package resource ${file.path}`);
    paths.add(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, `invalid resource size ${file.path}`);
    assert.ok(Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o7777, `invalid resource mode ${file.path}`);
    bytes += file.size;
  }
  assert.equal(pack.unpackedSize, bytes, "npm pack unpacked size does not match resources");
  return pack;
}
