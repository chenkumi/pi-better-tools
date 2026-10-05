# Install, migrate and roll back

## Before enabling the integration

1. Back up the relevant Pi settings file. Review `pi list` and `pi config` in both personal/project scopes.
2. Disable the extension resources of the old five standalone packages and pi-pty-terminal. Preserve their folders, credentials and persistent state. Different package identities do not deduplicate same-named tools.
3. In this repository run `npm ci --ignore-scripts`, `npm run pty:install` and `npm run build`; install Chromium explicitly if Fetch is needed.
4. Run `pi install D:/projects/pi-better-tools`, or use `-l` for the intended project. Project packages require the existing trust policy; do not enable automatic approve just to avoid errors.
5. Reload/restart Pi. Check the loaded tools, `/web-tools status` and `schedule_status`. Do not create a real job just to test installation.

No script here automatically changes user settings/auth, deletes logs, removes old packages or edits scheduler registry data.

## Pi 1.0.0 development upgrade

根四個 Pi devDependencies 與唯一 lockfile 固定為 1.0.0；在根目錄執行 `npm ci --ignore-scripts`、`npm run build`，不要依 modules 的歷史 manifests 個別安裝。Runtime 仍由 host 提供 Pi peers；不修改使用者真實 Pi 安裝、auth、trust 或排程。

九個 extensions 使用的 hooks 不需要更名。Pi 1.0.0 預設 fullscreen；如需舊 UI 可自行用 `--tui-mode regular`，本專案不自動改設定。`/reload` 啟用新加入 defaultTools 的工具，但移除 defaults 不會停用已 active 工具；需要撤權使用工具排除／明確 allowlist，而非僅改 defaultTools。`defaultTools: ["read"]` 也不抑制 default-active extension tools；唯讀使用 `--tools read`。

保存資料不遷移：Subagents `hostContract: "0.99.1"`、Scheduler schema 與 entry names 均保留。升級 SDK 不允許直接把 durable format 字串換為 1.0.0；已有 managed sessions 仍依原 owner／fingerprint／guard 驗證。

## Module/resource selection

Use `pi config` or a package entry's `extensions`/`prompts` filters. Paths are relative to the integration root (`modules/...`). Tool activation/exclusions are separate: disabling `schedule_*` tools alone does not unload the Scheduler extension or its host lifecycle; filter the Scheduler entry if the host itself should not start.

## Unified TypeScript entry points

All nine public Pi entries now use `modules/<name>/src/index.ts`. If package resource filters or explicit `-e` paths referenced `extensions/...`, Scheduler `dist/extension.js` / `src/extension.ts`, or JSON Schema's root `index.ts`, update them manually to the matching new path. This repository does not rewrite personal/project settings. Exclusion filters referencing an old path no longer exclude the new entry; review filters before reload, especially Scheduler host activation. Do not load both an old implementation entry and its new forwarding entry, as that registers tools/hooks twice.

Scheduler's extension no longer needs a build; `/reload` or restart loads the TS sources. The standalone `pi-scheduler` CLI still uses `dist/runner.js` and requires root `npm run build` when developing from source. Sources and CLI artifacts ship in the same package; no second installation unit is added. No persistent data or bundled-agent paths are moved.

## Subagent persistence API change

All initial single/parallel/chain tasks now create managed native sessions automatically. Remove `resumable: true` or `resumable: false` from callers; the removed parameter is explicitly rejected. Resume still accepts only `{ resume: "<complete returned subagentSessionId>", task: "<new work>" }`. Failure/cancellation does not grant resumability: only a verified ready checkpoint can continue. Reload/restart Pi to refresh the tool schema and prompt guidelines.

Existing managed sessions retain their format and guards, but old ephemeral logs cannot be resumed or reconstructed into native history. No log/session conversion or cleanup runs during upgrade. Persistent storage is now required for every dispatch; metadata/transcript creation failures refuse execution rather than falling back to a no-session child.

## Goal removal

本整合包已移除 Goal 模組，不再提供 `/goal` 指令、`goal` 工具或自動續跑。更新後請 `/reload` 或重新啟動 Pi；若個人／專案 settings 的 resource filters、`-e` 路徑或工具 allowlist 仍指向 Goal，請手動移除。Repository 不會自動修改使用者設定。

既有 sessions 的 `pi-better-goal-state` entries 與歷史工具結果保留，不遷移、重播或刪除；移除模組不會還原既有專案修改。

## JSON Schema integration

Disable the standalone `@nqbao/pi-json-schema` before loading `modules/json-schema/src/index.ts`; the same tool and flag names are not safe to load twice. No source-project, settings or auth files are edited automatically.

The module is now a project-native rewrite (zod 4 replaces Ajv), not a snapshot of 0.1.1. Differences a script author will notice: only `--json-schema` and `--json-output` exist (`--json-output` selects file delivery, otherwise stdout); `--json-delivery` and `--json-fallback` were removed and the fallback is always best-effort (the `force` mode is gone); schemas using `if/then/else`, `not`, `dependent*`, external `$ref` or typeless type-specific constraints are rejected at startup. Explicit tool allowlists must include `json_output`; exclusions and no-tools stay authoritative. Full contract: `modules/json-schema/README.md`.

## PTY integration

停用獨立 `pi-pty-terminal`，只載入整合入口 `modules/pty-terminal/src/index.ts`。原七個工具保留，spawn target 預設 local；新增 `pi-pty-terminal.targets` named WSL/SSH settings，不自動寫設定或搬移 session。原生 dependency setup 在 ignore-scripts 安裝後需明確 `npm run pty:install`；此步驟只執行 node-pty lifecycle，不啟動遠端連線或下載 Chromium。跨平台不可共用 node_modules。

現有 PTY session 無法跨 extension reload/移轉恢復；先完成工作或明確關閉。Windows kill/shutdown 不傳 POSIX signal；WSL/SSH kill 是 transport 關閉，不保證遠端背景程序停止。完整 target 路徑、env、SSH prerequisites 見 `modules/pty-terminal/README.md`。

## Existing data

Debug namespaces, Web configuration and storage paths remain compatible. Scheduler's local folder spelling `pi-schedular` is not its state/debug namespace (`pi-scheduler`). No schema migration or replay is performed.

Existing managed Subagent sessions can include absolute agent source paths and fingerprints. Integration packaging changes bundled paths, so cross-package continuation is not guaranteed. Keep the old package/path available for old sessions rather than editing saved manifests to bypass guards.

Old OS scheduler tasks are not automatically removed. If a historical Windows runner is still registered, inspect its active work and disable it manually before using app-owned scheduling.

## Roll back

1. Disable the integration extensions (or remove only its Pi package declaration with `pi remove <source>` in the correct scope).
2. Re-enable the previous standalone extension resources.
3. Reload/restart and confirm only one owner per tool name.

Do not delete shared schedules/native sessions/logs as part of rollback. No rollback can undo completed tool side effects, and cancellation does not establish arbitrary descendant-process termination.
