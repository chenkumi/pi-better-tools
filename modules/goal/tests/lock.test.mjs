// owner.json: exactly one process wins a simultaneous claim, and a record of another process is never removed by release.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const { claim, release } = await import("../src/lock.ts")
const root = mkdtempSync(join(tmpdir(), "goal-lock-"))
after(() => rmSync(root, { recursive: true, force: true }))
const fresh = (name) => { const dir = join(root, name); mkdirSync(dir); return dir }

/** Two processes call claim at the same instant (a shared start time) and report whether they won; they stay alive until both have reported. */
async function race(dir) {
  const startAt = Date.now() + 1500
  const script = `
    const { claim } = await import(${JSON.stringify(new URL("../src/lock.ts", import.meta.url).href)})
    while (Date.now() < ${startAt}) {}
    const won = await claim(${JSON.stringify(dir)})
    console.log(String(won))
    process.stdin.once("data", () => process.exit(0))
  `
  const children = [0, 1].map(() => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] }))
  const results = await Promise.all(children.map((child) => new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(chunk.toString().trim() === "true")))))
  for (const child of children) child.stdin.end("go\n")
  return results
}

describe("goal owner lock", () => {
  it("lets exactly one of two simultaneous processes take a free goal", async () => {
    for (let round = 0; round < 3; round++) {
      const results = await race(fresh(`race-${round}`))
      assert.equal(results.filter(Boolean).length, 1, `round ${round}: ${results}`)
    }
  })

  it("takes over a record whose process is gone, and leaves one whose process lives", async () => {
    const gone = fresh("gone")
    writeFileSync(join(gone, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }))
    assert.equal(await claim(gone), true)
    assert.equal(JSON.parse(readFileSync(join(gone, "owner.json"), "utf8")).pid, process.pid)
    const live = fresh("live")
    writeFileSync(join(live, "owner.json"), JSON.stringify({ pid: process.ppid }))
    assert.equal(await claim(live), false)
    assert.equal(existsSync(join(live, "owner.pid.tmp")), false)
  })

  it("release removes only its own record", async () => {
    const dir = fresh("release")
    assert.equal(await claim(dir), true)
    await release(dir)
    assert.equal(existsSync(join(dir, "owner.json")), false)
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.ppid }))
    await release(dir)
    assert.equal(existsSync(join(dir, "owner.json")), true, "another process's record stays")
  })
})
