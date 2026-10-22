export type FileAction = "read" | "write" | "edit" | "note";
export interface Limits { windowRuns: number; maxFiles: number }
export interface Activity {
  path: string;
  action: FileAction;
  run: number;
  readRun?: number;
  writeRun?: number;
  createdRun?: number;
}
export const DEFAULT_LIMITS: Readonly<Limits> = { windowRuns: 4, maxFiles: 50 };
export const MAX_PATH_BYTES = 4096;
export const MAX_ID_BYTES = 1024;
export const MAX_PENDING = 128;
export function boundedString(value: unknown, maxBytes = MAX_PATH_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes &&
    !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}
export function validateLimits(limits: Limits): void {
  if (!Number.isSafeInteger(limits.windowRuns) || limits.windowRuns < 1 || limits.windowRuns > 30 ||
      !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || limits.maxFiles > 500) {
    throw new Error("Limits require window 1–30 and max-files 1–500 (integers).");
  }
}
/** Counters saturate instead of losing integer precision in a very long session. */
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
export class ActivityWindow {
  private readonly files = new Map<string, Activity>();
  private settings: Limits;
  run = 0;
  since = new Date().toISOString();
  readonly stats = { capacityEvictions: 0, expired: 0, skipped: 0 };
  constructor(limits: Limits = DEFAULT_LIMITS) { validateLimits(limits); this.settings = { ...limits }; }
  get limits(): Limits { return { ...this.settings }; }
  skip(): void { this.stats.skipped = increment(this.stats.skipped); }
  advance(): void { this.run++; this.prune(); }
  configure(limits: Limits): void { validateLimits(limits); this.settings = { ...limits }; this.prune(); }
  record(path: string, action: FileAction): void {
    if (!boundedString(path)) { this.skip(); return; }
    const previous = this.files.get(path);
    const item: Activity = { ...previous, path, action, run: this.run };
    if (action === "read") item.readRun = this.run;
    else item.writeRun = this.run;
    if (action === "note") item.createdRun = this.run;
    // Updating an existing Map key does not update insertion order.
    this.files.delete(path);
    this.files.set(path, item);
    this.prune();
  }
  snapshot(): Activity[] { return Array.from(this.files.values(), item => ({ ...item })).reverse(); }
  clear(resetLimits = false): void {
    this.files.clear(); this.run = 0; this.since = new Date().toISOString();
    this.stats.capacityEvictions = 0; this.stats.expired = 0; this.stats.skipped = 0;
    if (resetLimits) this.settings = { ...DEFAULT_LIMITS };
  }
  private prune(): void {
    const cutoff = this.run - this.settings.windowRuns;
    for (const [path, item] of this.files) {
      if (item.run <= cutoff) {
        this.files.delete(path); this.stats.expired = increment(this.stats.expired);
      } else {
        if (item.readRun !== undefined && item.readRun <= cutoff) delete item.readRun;
        if (item.writeRun !== undefined && item.writeRun <= cutoff) delete item.writeRun;
        if (item.createdRun !== undefined && item.createdRun <= cutoff) delete item.createdRun;
      }
    }
    while (this.files.size > this.settings.maxFiles) {
      this.files.delete(this.files.keys().next().value!);
      this.stats.capacityEvictions = increment(this.stats.capacityEvictions);
    }
  }
}
