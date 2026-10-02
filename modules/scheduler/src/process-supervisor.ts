import type { ProcessIdentity, Run } from "./domain.js";
import type { ProcessInspector, ProcessTerminator } from "./runtime-deps.js";
import { commandLineFingerprint } from "./pi-process-executor.js";

function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

/** Never returns true from a PID alone: start time and command fingerprint must both match. */
export async function identityMatches(identity: ProcessIdentity, inspector: ProcessInspector): Promise<boolean> {
  const observed = await inspector.inspect(identity.pid);
  return observed !== undefined
    && observed.pid === identity.pid
    && sameInstant(observed.startedAt, identity.startedAt)
    && commandLineFingerprint(observed.commandLine) === identity.commandFingerprint;
}

export class ProcessSupervisor {
  constructor(private readonly inspector: ProcessInspector, private readonly terminator: ProcessTerminator) {}

  async cancelRecoveredRun(run: Run): Promise<"terminated" | "orphaned"> {
    if (!run.processIdentity || !(await identityMatches(run.processIdentity, this.inspector))) return "orphaned";
    await this.terminator.terminateTree(run.processIdentity.pid);
    return "terminated";
  }
}
