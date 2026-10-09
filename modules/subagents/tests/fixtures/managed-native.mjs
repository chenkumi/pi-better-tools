// Deterministic offline child emitting a real native v3 file and startup metadata.
// This is not Pi itself; real CLI coverage separately verifies the actual guard.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
const scenario = process.argv[2];
const args = process.argv.slice(3);
const value = key => args[args.indexOf(key) + 1];
const guard = JSON.parse(process.env.PI_SUBAGENTS_GUARD);
const file = args.includes("--session") ? value("--session") : join(value("--session-dir"), "fixture.jsonl");
const previous = args.includes("--session") ? readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
let leaf = previous.at(-1)?.id ?? "";
const model = guard.model ?? "offline-fixture/model";
const thinkingLevel = guard.thinkingLevel ?? "off";
const timestamp = new Date().toISOString();
const entry = (type, extra) => { const id = ulid().toUpperCase(); const record = { type, id, parentId: leaf || null, timestamp, ...extra }; leaf = id; return record; };
const header = { type: "session", version: 3, id: guard.id, cwd: guard.cwd };
const entries = previous.length ? [] : [header,
  entry("model_change", { provider: model.slice(0, model.indexOf("/")), modelId: scenario === "changed-model" ? "changed" : model.slice(model.indexOf("/") + 1) }),
  entry("thinking_level_change", { thinkingLevel })];
const rpc = value("--mode") === "rpc";
const emit = event => console.log(JSON.stringify(event));
if (rpc) {
  if (!previous.length) appendFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  if (scenario !== "missing-startup") writeFileSync(guard.startupPath, JSON.stringify({ version: 1, id: guard.id, cwd: guard.cwd, model, thinkingLevel, childTrusted: false }));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      let data = {};
      if (command.type === "get_state") data = { sessionId: guard.id, sessionFile: file, model: { provider: model.slice(0, model.indexOf("/")), id: model.slice(model.indexOf("/") + 1) }, thinkingLevel };
      if (command.type === "get_entries") data = { entries: command.since ? [] : entries.filter(e => e.type !== "session"), leafId: leaf || null };
      if (command.type === "prompt") data = { disposition: "started" };
      emit({ type: "response", id: command.id, command: command.type, success: true, data });
      if (command.type === "prompt") {
        const user = { role: "user", content: command.message, timestamp: Date.now() };
        const assistant = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ previousUsers: previous.filter(e => e.message?.role === "user").length, task: command.message }) }], stopReason: "stop", timestamp: Date.now() };
        appendFileSync(file, [entry("message", { message: user }), entry("message", { message: assistant })].map(e => JSON.stringify(e)).join("\n") + "\n");
        emit({ type: "message_end", message: user }); emit({ type: "message_end", message: assistant }); emit({ type: "agent_settled" });
      }
    }
  });
  process.stdin.on("end", () => { if (scenario === "exit-failure") process.exitCode = 1; });
} else {
const task = readFileSync(args.at(-1).slice(1), "utf8");
const user = { role: "user", content: task, timestamp: Date.now() };
const assistant = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ previousUsers: previous.filter(e => e.message?.role === "user").length, task }) }], stopReason: "stop", timestamp: Date.now() };
entries.push(entry("message", { message: user }), entry("message", { message: assistant }));
appendFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
if (scenario !== "missing-startup") writeFileSync(guard.startupPath, JSON.stringify({ version: 1, id: guard.id, cwd: guard.cwd, model, thinkingLevel, childTrusted: false }));
if (scenario !== "missing-header") emit(header);
emit({ type: "message_end", message: user });
emit({ type: "message_end", message: assistant });
emit({ type: "agent_settled" });
if (scenario === "exit-failure") process.exitCode = 1;
}
