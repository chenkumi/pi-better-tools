// One session runs a goal at a time: `owner.json` in the goal's folder names the process that runs it. A goal whose owner is gone
// (Pi closed, crashed) is free again, so the next session continues it; a goal whose owner is alive is left alone.
import { link, readFile, rm, writeFile } from "node:fs/promises"
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

async function currentPid(dir: string): Promise<number | undefined> {
  try {
    const { pid } = JSON.parse(await readFile(file(dir), "utf8")) as { pid?: unknown }
    return typeof pid === "number" ? pid : undefined
  } catch {
    return undefined
  }
}

/** The pid of another live process that runs this goal; undefined when it is free (or ours). */
export async function otherOwner(dir: string): Promise<number | undefined> {
  const pid = await currentPid(dir)
  return pid !== undefined && pid !== process.pid && alive(pid) ? pid : undefined
}

/**
 * Takes the goal for this process; false when another live process holds it. The record is written to a private file and
 * then linked into place, which fails when `owner.json` exists: two processes cannot both win, and a reader never sees a
 * half-written record. A record left by a process that is gone is removed and the link retried; two processes that remove the
 * same stale record at the same moment can still race, which needs a crashed owner and two simultaneous starts.
 */
export async function claim(dir: string): Promise<boolean> {
  const mine = join(dir, `owner.${process.pid}.tmp`)
  await writeFile(mine, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", "utf8")
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(mine, file(dir))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const holder = await currentPid(dir)
      if (holder === process.pid) return true
      if (holder !== undefined && alive(holder)) return false
      await rm(file(dir), { force: true })
    }
    return false
  } finally {
    await rm(mine, { force: true })
  }
}

/** Frees the goal; a record that names another process (taken over after this one was thought gone) is left alone. */
export async function release(dir: string): Promise<void> {
  const holder = await currentPid(dir)
  if (holder === undefined || holder === process.pid) await rm(file(dir), { force: true })
}
