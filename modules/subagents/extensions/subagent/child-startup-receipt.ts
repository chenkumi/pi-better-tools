import * as fs from "node:fs";

interface OwnedReceipt {
  path: string;
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
}
const RECEIPTS = Symbol.for("pi-better-tools.subagents.verified-startup-receipts.v1");
// Reload creates a fresh module runtime. Only the same parsed handshake object
// in this process may reuse a receipt; a newly consumed payload gets no lease.
// Existing same-process runtimes may have the old serialized-string cache.
// Upgrade it only AFTER the same strict raw-byte/file checks, never via decoding.
type LegacyOwnedReceipt = Omit<OwnedReceipt, "bytes"> & { bytes: string };
const processState = globalThis as typeof globalThis & { [RECEIPTS]?: WeakMap<object, OwnedReceipt | LegacyOwnedReceipt> };
const receipts = processState[RECEIPTS] ??= new WeakMap<object, OwnedReceipt | LegacyOwnedReceipt>();

const changed = () => Object.assign(new Error("Managed startup receipt ownership/content changed; refusing reuse"), { code: "EEXIST" });
function verifyOwnedFile(owned: OwnedReceipt): void {
  if (owned.ino === 0n) throw changed(); // No trustworthy file identity: do not guess/reuse.
  const size = BigInt(owned.bytes.length);
  const matchesOwned = (info: fs.BigIntStats) => info.isFile() && !info.isSymbolicLink()
    && info.dev === owned.dev && info.ino === owned.ino && info.size === size
    && typeof info.mtimeNs === "bigint" && typeof info.ctimeNs === "bigint";
  const sameObservation = (a: fs.BigIntStats, b: fs.BigIntStats) => matchesOwned(b)
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const link = fs.lstatSync(owned.path, { bigint: true });
  if (!matchesOwned(link)) throw changed();
  const fd = fs.openSync(owned.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (!sameObservation(link, info)) throw changed();
    if (!fs.readFileSync(fd).equals(owned.bytes)) throw changed(); // No lossy UTF-8 decoding.
    const afterFd = fs.fstatSync(fd, { bigint: true });
    if (!sameObservation(info, afterFd)) throw changed();
    const afterPath = fs.lstatSync(owned.path, { bigint: true });
    if (!sameObservation(afterFd, afterPath)) throw changed();
    // These are checkpoint observations, NOT an atomic snapshot or a guarantee
    // against transient/restored changes or writes after the final check.
  } finally { fs.closeSync(fd); }
}

/** Preserve wx for every new invocation. Reload only revalidates its own exact
 * previously verified file, read-only; deletion/replacement never recreates it.
 * Rejected initial receipts are not marked verified, nor may they be reused.
 */
export function verifyStartupReceipt(expected: object & { startupPath: string }, receipt: object, valid: boolean): void {
  const bytes = Buffer.from(JSON.stringify(receipt), "utf8"), owned = receipts.get(expected);
  if (owned) {
    if (!valid) return; // Explicit config/trust rejection takes precedence over receipt I/O.
    const raw = Buffer.isBuffer(owned.bytes) ? owned as OwnedReceipt : { ...owned, bytes: Buffer.from(owned.bytes, "utf8") };
    if (raw.path !== expected.startupPath || !raw.bytes.equals(bytes)) throw changed();
    verifyOwnedFile(raw);
    if (raw !== owned) receipts.set(expected, raw); // Legacy cache upgrade only after raw verification; never writes a file.
    return;
  }
  const fd = fs.openSync(expected.startupPath, "wx", 0o600);
  let candidate: OwnedReceipt;
  try {
    fs.writeFileSync(fd, bytes);
    const info = fs.fstatSync(fd, { bigint: true });
    candidate = { path: expected.startupPath, bytes, dev: info.dev, ino: info.ino };
  } finally { fs.closeSync(fd); }
  if (valid) {
    verifyOwnedFile(candidate);
    receipts.set(expected, candidate); // Only after actual successful write/close/path validation.
  }
}
