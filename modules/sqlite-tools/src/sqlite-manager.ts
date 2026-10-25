// The SQLite connection logic lives in plain JavaScript (sqlite-core.mjs): the SQLite child process is started by plain
// Node, which refuses to strip TypeScript from files inside node_modules. This module keeps the original import path.
export * from "./sqlite-core.mjs";
