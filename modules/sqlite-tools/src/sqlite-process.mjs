// Hosts the synchronous node:sqlite connection in its own process, so a long statement cannot freeze Pi and
// cancelling it can kill the process (a worker thread cannot be stopped while a native call runs).
import { SqliteManager } from "./sqlite-core.mjs";

const manager = new SqliteManager();
const METHODS = new Set(["open", "close", "status", "query", "execute", "listTables", "describeTable"]);

process.on("message", ({ id, method, args }) => {
  try {
    if (!METHODS.has(method)) throw new Error(`Unknown SQLite process method: ${method}`);
    process.send({ id, ok: true, value: manager[method](...args) });
  } catch (error) {
    process.send({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
// The parent is gone (crash or quit without cleanup): do not outlive it.
process.on("disconnect", () => process.exit(0));
process.send({ ready: true });
