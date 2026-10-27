// Hosts the synchronous node:sqlite connection in its own process, so a long statement cannot freeze Pi and
// cancelling it can kill the process (a worker thread cannot be stopped while a native call runs).
import { decode, encode } from "./ipc-codec.mjs";
import { SqliteManager } from "./sqlite-core.mjs";

const manager = new SqliteManager();
const METHODS = new Set(["open", "close", "status", "query", "execute", "listTables", "describeTable"]);
let received = false;

// The parent reads this stream only while it waits for startup; a closed pipe must not turn exit 0 into a crash.
process.stderr.on("error", () => {});
process.on("message", ({ id, method, args }) => {
  received = true;
  try {
    if (!METHODS.has(method)) throw new Error(`Unknown SQLite process method: ${method}`);
    process.send({ id, ok: true, value: encode(manager[method](...decode(args))) });
  } catch (error) {
    process.send({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
// The parent is gone (crash or quit without cleanup): do not outlive it.
process.on("disconnect", () => {
  if (!received) process.stderr.write("SQLite process: the IPC channel closed before any request arrived.\n");
  process.exit(0);
});
process.send({ ready: true });
