import { copyFile, readFile } from "node:fs/promises";
import { atomicWriteFile } from "./atomic-rename.js";
import { createHash } from "node:crypto";
import { ulid } from "ulid";

import { emptyRegistry, SCHEDULER_SCHEMA_VERSION, type Schedule, type SchedulerRegistry } from "./domain.js";
import { validateExecutionProfile } from "./execution-profile.js";
import { validateTiming } from "./cron-engine.js";
import { withAdvisoryLock } from "./locking.js";

export class RevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Revision conflict: expected ${expected}, actual ${actual}`);
    this.name = "RevisionConflictError";
  }
}

export class RegistryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryFormatError";
  }
}

export interface CreateScheduleInput {
  id?: string;
  mode: Schedule["mode"];
  title?: string;
  prompt: string;
  cwd: string;
  timing: Schedule["timing"];
  execution?: Schedule["execution"];
  projectTrust?: boolean;
  targetSessionId?: string;
}

export interface RegistryStoreOptions {
  registryPath: string;
  lockPath: string;
  now?: () => string;
}

async function readRegistry(path: string): Promise<SchedulerRegistry> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new RegistryFormatError("Registry must be an object");
    const registry = parsed as SchedulerRegistry;
    if (registry.schemaVersion !== SCHEDULER_SCHEMA_VERSION || typeof registry.revision !== "number" || !registry.schedules) {
      throw new RegistryFormatError("Unsupported or malformed scheduler registry");
    }
    return registry;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyRegistry();
    if (error instanceof SyntaxError) throw new RegistryFormatError(`Invalid registry JSON: ${error.message}`);
    throw error;
  }
}

async function atomicWrite(path: string, data: SchedulerRegistry): Promise<void> {
  // Keep the last good registry so a corrupt or lost write is recoverable by hand.
  await copyFile(path, `${path}.bak`).catch(() => undefined);
  await atomicWriteFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export class RegistryStore {
  private readonly now: () => string;

  constructor(private readonly options: RegistryStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  sessionLockPath(sessionId: string): string {
    return `${this.options.registryPath}.session-${createHash("sha256").update(sessionId).digest("hex")}.lock`;
  }

  async get(): Promise<SchedulerRegistry> {
    return readRegistry(this.options.registryPath);
  }

  async list(includeDeleted = false): Promise<Schedule[]> {
    const registry = await this.get();
    return Object.values(registry.schedules).filter((schedule) => includeDeleted || schedule.state !== "deleted");
  }

  async mutate<T>(expectedRevision: number | undefined, mutation: (registry: SchedulerRegistry) => T): Promise<T> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const registry = await readRegistry(this.options.registryPath);
      if (expectedRevision !== undefined && registry.revision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, registry.revision);
      }
      const value = mutation(registry);
      registry.revision += 1;
      await atomicWrite(this.options.registryPath, registry);
      return value;
    });
  }

  async create(input: CreateScheduleInput, expectedRevision?: number): Promise<Schedule> {
    return this.mutate(expectedRevision, (registry) => {
      const now = this.now();
      const id = input.id ?? ulid().toLowerCase();
      if (registry.schedules[id]) throw new Error(`Schedule already exists: ${id}`);
      if (!input.prompt.trim()) throw new Error("Schedule prompt cannot be blank");
      if (input.mode === "session" && !input.targetSessionId) throw new Error("Session schedules require targetSessionId");
      validateTiming(input.timing);
      const schedule: Schedule = {
        id,
        revision: 1,
        mode: input.mode,
        state: "active",
        ...(input.title ? { title: input.title } : {}),
        prompt: input.prompt,
        cwd: input.cwd,
        timing: input.timing,
        ...(validateExecutionProfile(input.execution) ? { execution: validateExecutionProfile(input.execution) } : {}),
        ...(input.projectTrust ? { projectTrust: true } : {}),
        ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      registry.schedules[id] = schedule;
      return schedule;
    });
  }

  async update(id: string, expectedRevision: number, patch: Partial<Pick<Schedule, "title" | "prompt" | "cwd" | "timing" | "execution" | "projectTrust" | "targetSessionId">> & { state?: "active" | "paused" }): Promise<Schedule> {
    return this.mutate(undefined, (registry) => {
      const schedule = registry.schedules[id];
      if (!schedule || schedule.state === "deleted") throw new Error(`Unknown schedule: ${id}`);
      if (schedule.revision !== expectedRevision) throw new RevisionConflictError(expectedRevision, schedule.revision);
      if (patch.prompt !== undefined && !patch.prompt.trim()) throw new Error("Schedule prompt cannot be blank");
      if (patch.execution !== undefined) validateExecutionProfile(patch.execution);
      if (patch.timing !== undefined) validateTiming(patch.timing);
      if (patch.state !== undefined) {
        if (patch.state !== "active" && patch.state !== "paused") throw new Error("update() can only set state to active or paused");
        if (schedule.state === "cancelled") throw new Error("Cancelled schedules cannot be resumed; create a new schedule.");
      }
      // Whitelist: a patch must never carry arbitrary fields (id, revision, lastPlannedAt, createdAt, ...).
      const allowed: Partial<Schedule> = {};
      for (const key of ["title", "prompt", "cwd", "timing", "projectTrust", "targetSessionId", "state"] as const) {
        if (patch[key] !== undefined) Object.assign(allowed, { [key]: patch[key] });
      }
      const updated: Schedule = {
        ...schedule,
        ...allowed,
        ...(patch.timing && JSON.stringify(patch.timing) !== JSON.stringify(schedule.timing) ? { lastPlannedAt: undefined, lastRunId: undefined } : {}),
        ...(patch.execution !== undefined ? { execution: validateExecutionProfile(patch.execution) } : {}),
        revision: schedule.revision + 1,
        updatedAt: this.now(),
      };
      registry.schedules[id] = updated;
      return updated;
    });
  }

  /** At-most-once claim. Persist BEFORE launching; a crash may skip, never replay, this occurrence. */
  async claim(id: string, revision: number, runId: string, at: string, slot: string = at): Promise<Schedule | undefined> {
    return this.mutate(undefined, (registry) => {
      const schedule = registry.schedules[id];
      if (!schedule || schedule.state !== "active" || schedule.revision !== revision) return undefined;
      if (schedule.timing.kind === "once" && schedule.lastPlannedAt) return undefined;
      // Per-occurrence dedupe: a second claimant (e.g. a demoted host racing a new one) for the same or an
      // older slot is rejected. lastPlannedAt records the claimed slot.
      if (schedule.lastPlannedAt && Date.parse(schedule.lastPlannedAt) >= Date.parse(slot)) return undefined;
      schedule.lastPlannedAt = slot;
      schedule.lastRunId = runId;
      return { ...schedule };
    });
  }

  async setState(id: string, expectedRevision: number, state: Schedule["state"]): Promise<Schedule> {
    return this.updateState(id, expectedRevision, state);
  }

  private async updateState(id: string, expectedRevision: number, state: Schedule["state"]): Promise<Schedule> {
    return this.mutate(undefined, (registry) => {
      const schedule = registry.schedules[id];
      if (!schedule) throw new Error(`Unknown schedule: ${id}`);
      if (schedule.state === "deleted") throw new Error(`Schedule is deleted and cannot change state: ${id}`);
      if (schedule.revision !== expectedRevision) throw new RevisionConflictError(expectedRevision, schedule.revision);
      const updated: Schedule = { ...schedule, state, revision: schedule.revision + 1, updatedAt: this.now() };
      registry.schedules[id] = updated;
      return updated;
    });
  }
}
