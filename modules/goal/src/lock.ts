// One session runs a goal at a time: `owner.json` in the goal's folder names the process that runs it. A goal whose owner is gone
// (Pi closed, crashed) is free again, so the next session continues it; a goal whose owner is alive is left alone.
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const file = (dir: string): string => join(dir, "owner.json")

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The pid of another live process that runs this goal; undefined when it is free (or ours). */
export async function otherOwner(dir: string): Promise<number | undefined> {
  try {
    const { pid } = JSON.parse(await readFile(file(dir), "utf8")) as { pid?: unknown }
    return typeof pid === "number" && pid !== process.pid && alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

/** Takes the goal for this process; false when another live process holds it. */
export async function claim(dir: string): Promise<boolean> {
  if ((await otherOwner(dir)) !== undefined) return false
  await writeFile(file(dir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", "utf8")
  return true
}

export async function release(dir: string): Promise<void> {
  await rm(file(dir), { force: true })
}
