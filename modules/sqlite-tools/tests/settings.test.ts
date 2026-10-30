import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPatches, readRaw, removeFile, writeJsonAtomic } from "../../pi-runtime/src/settings-panel/index.js";
import { registerSqliteSettings, sqliteSettings } from "../src/settings.js";

function withFile(fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sqlite-settings-"));
  try { fn(join(dir, ".pi", "agent", "sqlite.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** What the command does on Save, against a real file. */
function save(file: string, edits: Record<string, string>) {
  const schema = sqliteSettings(file, {});
  const state = readRaw(file), raw = state.state === "ok" ? state.raw : {};
  const current = schema.parse(raw), values = { ...schema.toValues(current), ...edits };
  const next = applyPatches(raw, schema.toPatch(values, new Set(Object.keys(edits)), current));
  schema.parse(next);
  if (schema.deleteWhenEmpty && !Object.keys(next).length) removeFile(file); else writeJsonAtomic(file, next);
}

test("fixed mode writes databasePath trimmed and the extension's own format stays {databasePath}", () => withFile((file) => {
  save(file, { mode: "fixed", databasePath: "  ./data/app.sqlite " });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { databasePath: "./data/app.sqlite" });
  assert.equal(sqliteSettings(file, {}).toValues(sqliteSettings(file, {}).parse(JSON.parse(readFileSync(file, "utf8")))).mode, "fixed");
}));

test("fixed mode without a path is refused and writes nothing", () => withFile((file) => {
  assert.throws(() => save(file, { mode: "fixed" }), /Enter a database path/);
  assert.equal(existsSync(file), false);
}));

test("back to manual mode removes the file when nothing else is in it, and keeps other keys otherwise", () => withFile((file) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ databasePath: "./a.sqlite" }));
  save(file, { mode: "manual" });
  assert.equal(existsSync(file), false, "a file without databasePath would be an error for the extension");
  writeFileSync(file, JSON.stringify({ databasePath: "./a.sqlite", note: "keep" }));
  save(file, { mode: "manual" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { note: "keep" });
}));

test("an invalid existing databasePath is rejected by parse, and SQLITE_PATH raises a notice", () => {
  const schema = sqliteSettings("/x/sqlite.json", { SQLITE_PATH: "/tmp/env.sqlite" });
  assert.throws(() => schema.parse({ databasePath: "  " }), /CONFIG_INVALID/);
  assert.match(schema.notice ?? "", /SQLITE_PATH/);
  assert.equal(sqliteSettings("/x/sqlite.json", {}).notice, undefined);
});

test("/settings:sqlite-tools refuses an untrusted project without opening anything", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  registerSqliteSettings({ registerCommand: (name: string, c: never) => commands.set(name, c) } as unknown as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["settings:sqlite-tools"]);
  const notes: string[] = [];
  let opened = false;
  await commands.get("settings:sqlite-tools")!.handler("", { cwd: "/p", hasUI: true, mode: "tui", isProjectTrusted: () => false, ui: { notify: (m: string) => notes.push(m), custom: async () => { opened = true; } } });
  assert.equal(opened, false);
  assert.match(notes[0] ?? "", /not trusted/);
});
