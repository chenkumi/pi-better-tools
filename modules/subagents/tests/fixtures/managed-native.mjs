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
const entry = (type, extra) => { const id = ulid().toLowerCase(); const record = { type, id, parentId: leaf || null, timestamp, ...extra }; leaf = id; return record; };
const header = { type: "session", version: 3, id: guard.id, cwd: guard.cwd };
const entries = previous.length ? [] : [header,
  entry("model_change", { provider: model.slice(0, model.indexOf("/")), modelId: scenario === "changed-model" ? "changed" : model.slice(model.indexOf("/") + 1) }),
  entry("thinking_level_change", { thinkingLevel })];
const task = readFileSync(args.at(-1).slice(1), "utf8");
const user = { role: "user", content: task, timestamp: Date.now() };
const assistant = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ previousUsers: previous.filter(e => e.message?.role === "user").length, task }) }], stopReason: "stop", timestamp: Date.now() };
entries.push(entry("message", { message: user }), entry("message", { message: assistant }));
appendFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
if (scenario !== "missing-startup") writeFileSync(guard.startupPath, JSON.stringify({ version: 1, id: guard.id, cwd: guard.cwd, model, thinkingLevel, childTrusted: false }));
const emit = event => console.log(JSON.stringify(event));
if (scenario !== "missing-header") emit(header);
emit({ type: "message_end", message: user });
emit({ type: "message_end", message: assistant });
emit({ type: "agent_settled" });
if (scenario === "exit-failure") process.exitCode = 1;
