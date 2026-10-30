import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand } from "../../pi-runtime/src/settings-panel/index.js";
import type { Patch, SettingsSchema, Values } from "../../pi-runtime/src/settings-panel/index.js";

interface SqliteConfig { databasePath: string }

/** Reading is as lenient as the extension's own loader: other keys are ignored; only `databasePath` is checked when present. */
function parse(raw: unknown): SqliteConfig {
  const value = (raw as Record<string, unknown> | null)?.databasePath;
  if (value === undefined) return { databasePath: "" };
  if (typeof value !== "string" || !value.trim()) throw new Error("CONFIG_INVALID: databasePath: must be a non-empty string");
  return { databasePath: value };
}

export function sqliteSettings(path: string, env: NodeJS.ProcessEnv = process.env): SettingsSchema<SqliteConfig> {
  return {
    id: "sqlite-tools", title: "SQLite Tools", path, parse, deleteWhenEmpty: true,
    notice: env.SQLITE_PATH?.trim() ? "SQLITE_PATH is set in the environment and overrides this file." : undefined,
    afterSave: "Takes effect after /reload.",
    fields: [
      { key: "mode", type: "enum", group: "Database", label: "Mode", options: ["manual", "fixed"],
        help: "manual: the agent opens a database with sqlite_open. fixed: this database opens at startup and cannot be switched." },
      { key: "databasePath", type: "string", group: "Database", label: "Database path", placeholder: "./data/app.sqlite",
        visibleWhen: (v) => v.mode === "fixed", help: "Relative paths resolve against the project directory. A missing file is created on first open." },
    ],
    toValues: (c): Values => ({ mode: c.databasePath ? "fixed" : "manual", databasePath: c.databasePath }),
    toPatch(v): Patch[] {
      const key = ["databasePath"];
      if (v.mode === "manual") return [{ path: key, value: undefined }];
      const databasePath = String(v.databasePath ?? "").trim();
      if (!databasePath) throw new Error("Enter a database path, or choose manual mode.");
      return [{ path: key, value: databasePath }];
    },
  };
}

/** Project-level and only for trusted projects, matching where the extension itself reads the file. */
export function registerSqliteSettings(pi: ExtensionAPI): void {
  registerSettingsCommand(pi, (ctx) => ctx.isProjectTrusted()
    ? sqliteSettings(join(ctx.cwd, CONFIG_DIR_NAME, "agent", "sqlite.json"))
    : "This project is not trusted, so its SQLite settings are not read or written. Trust the project first.",
  { id: "sqlite-tools", title: "SQLite Tools" });
}
