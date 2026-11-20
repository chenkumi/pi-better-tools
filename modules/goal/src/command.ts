// Tier 1 checks: a command run in the workspace through the system shell. Stops with its process tree after a limit or when the goal stops.
import { spawn } from "node:child_process"

/** A check that has not ended after this long is stopped and counts as failed. */
const CHECK_TIMEOUT_MS = 10 * 60_000
const OUTPUT_TAIL = 64 * 1024

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(-pid, "SIGKILL")
  } catch {
    // already gone
  }
}

/** Runs the command through the system shell in `cwd`; resolves with the exit code (null: stopped or timed out) and the end of its output. */
export function runCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve({ exitCode: null, output: "" }) // an abort that already happened is not replayed to a listener added later
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.length > OUTPUT_TAIL * 2) output = output.slice(-OUTPUT_TAIL)
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    let note = ""
    const stop = () => killTree(child.pid)
    const timer = setTimeout(() => {
      note = `\n[stopped: still running after ${Math.round(timeoutMs / 1000)} s]`
      stop()
    }, timeoutMs)
    signal.addEventListener("abort", stop, { once: true })
    const end = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
    }
    child.once("error", (error) => {
      end()
      reject(error)
    })
    child.once("close", (code) => {
      end()
      resolve({ exitCode: note || signal.aborted ? null : code, output: output.slice(-OUTPUT_TAIL) + note })
    })
  })
}
