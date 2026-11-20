// runCommand: a signal that is already aborted must not start a process (an abort is not replayed to a listener added after it).
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const { runCommand } = await import("../src/command.ts")
const cwd = mkdtempSync(join(tmpdir(), "goal-command-"))
after(() => rmSync(cwd, { recursive: true, force: true }))

describe("runCommand", () => {
  it("does not spawn when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const marker = join(cwd, "ran")
    const result = await runCommand(`node -e "require('fs').writeFileSync(process.argv[1],'x')" "${marker}"`, cwd, controller.signal)
    assert.deepEqual(result, { exitCode: null, output: "" })
    assert.equal(existsSync(marker), false)
  })

  it("still runs a command with a live signal", async () => {
    const result = await runCommand(`node -e "process.exit(0)"`, cwd, new AbortController().signal)
    assert.equal(result.exitCode, 0)
  })
})
