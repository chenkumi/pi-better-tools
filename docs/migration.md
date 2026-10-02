# Install, migrate and roll back

## Before enabling the integration

1. Back up the relevant Pi settings file. Review `pi list` and `pi config` in both personal/project scopes.
2. Disable the extension resources of the old five standalone packages. Preserve their folders, credentials and persistent state. Different package identities do not deduplicate same-named tools.
3. In this repository run `npm ci --ignore-scripts` and `npm run build`; install Chromium explicitly if Fetch is needed.
4. Run `pi install D:/projects/pi-better-tools`, or use `-l` for the intended project. Project packages require the existing trust policy; do not enable automatic approve just to avoid errors.
5. Reload/restart Pi. Check the loaded tools, `/web-tools status` and `schedule_status`. Do not create a real job just to test installation.

No script here automatically changes user settings/auth, deletes logs, removes old packages or edits scheduler registry data.

## Pi 1.0.0 development upgrade

根四個 Pi devDependencies 與唯一 lockfile 固定為 1.0.0；在根目錄執行 `npm ci --ignore-scripts`、`npm run build`，不要依 modules 的歷史 manifests 個別安裝。Runtime 仍由 host 提供 Pi peers；不修改使用者真實 Pi 安裝、auth、trust 或排程。

八個 extensions 使用的 hooks 不需要更名。Pi 1.0.0 預設 fullscreen；如需舊 UI 可自行用 `--tui-mode regular`，本專案不自動改設定。`/reload` 啟用新加入 defaultTools 的工具，但移除 defaults 不會停用已 active 工具；需要撤權使用工具排除／明確 allowlist，而非僅改 defaultTools。`defaultTools: ["read"]` 也不抑制 default-active extension tools；唯讀使用 `--tools read`。

保存資料不遷移：Subagents `hostContract: "0.99.1"`、Goal／Scheduler schema 與 entry names 均保留。升級 SDK 不允許直接把 durable format 字串換為 1.0.0；已有 managed sessions 仍依原 owner／fingerprint／guard 驗證。

## Module/resource selection

Use `pi config` or a package entry's `extensions`/`prompts` filters. Paths are relative to the integration root (`modules/...`). Tool activation/exclusions are separate: disabling `schedule_*` tools alone does not unload the Scheduler extension or its host lifecycle; filter the Scheduler entry if the host itself should not start.

## Unified TypeScript entry points

All nine public Pi entries now use `modules/<name>/src/index.ts`. If package resource filters or explicit `-e` paths referenced `extensions/...`, Scheduler `dist/extension.js` / `src/extension.ts`, or JSON Schema's root `index.ts`, update them manually to the matching new path. This repository does not rewrite personal/project settings. Exclusion filters referencing an old path no longer exclude the new entry; review filters before reload, especially Scheduler host activation. Do not load both an old implementation entry and its new forwarding entry, as that registers tools/hooks twice.

Scheduler's extension no longer needs a build; `/reload` or restart loads the TS sources. The standalone `pi-scheduler` CLI still uses `dist/runner.js` and requires root `npm run build` when developing from source. Sources and CLI artifacts ship in the same package; no second installation unit is added. No persistent data or bundled-agent paths are moved.

## Subagent persistence API change

All initial single/parallel/chain tasks now create managed native sessions automatically. Remove `resumable: true` or `resumable: false` from callers; the removed parameter is explicitly rejected. Resume still accepts only `{ resume: "<complete returned subagentSessionId>", task: "<new work>" }`. Failure/cancellation does not grant resumability: only a verified ready checkpoint can continue. Reload/restart Pi to refresh the tool schema and prompt guidelines.

Existing managed sessions retain their format and guards, but old ephemeral logs cannot be resumed or reconstructed into native history. No log/session conversion or cleanup runs during upgrade. Persistent storage is now required for every dispatch; metadata/transcript creation failures refuse execution rather than falling back to a no-session child.

## Native Goal

啟用前停用舊同名 `/goal`／`goal` extension（包括獨立 pi-goal-x）；Pi 不以 package identity 去除同名命令／工具。根 manifest 直接載入 `modules/goal/src/index.ts`，如不需要請以 resource filters 排除；明確工具清單要加入 `goal` 才能開始／resume。沒有來源 goal state／plan／任務樹遷移，也不修改舊 sessions。

目標按目前 session branch 儲存；reload／恢復／fork／tree change 先暫停 active，明確 `/goal resume` 再授權。不用 `/reload` 清除儲存 fault：請先修好磁碟問題，再從已保存檔案重新開啟 session。停用／回退 extension 不撤銷已發生的專案修改。完整契約見 `modules/goal/README.md`。

## JSON Schema integration

Disable the standalone `@nqbao/pi-json-schema` before loading `modules/json-schema/src/index.ts`; the same tool and flag names are not safe to load twice. No source-project, settings or auth files are edited automatically.

The module is now a project-native rewrite (zod 4 replaces Ajv), not a snapshot of 0.1.1. Differences a script author will notice: only `--json-schema` and `--json-output` exist (`--json-output` selects file delivery, otherwise stdout); `--json-delivery` and `--json-fallback` were removed and the fallback is always best-effort (the `force` mode is gone); schemas using `if/then/else`, `not`, `dependent*`, external `$ref` or typeless type-specific constraints are rejected at startup. Explicit tool allowlists must include `json_output`; exclusions and no-tools stay authoritative. Full contract: `modules/json-schema/README.md`.

## Existing data

Debug namespaces, Web configuration and storage paths remain compatible. Scheduler's local folder spelling `pi-schedular` is not its state/debug namespace (`pi-scheduler`). No schema migration or replay is performed.

Existing managed Subagent sessions can include absolute agent source paths and fingerprints. Integration packaging changes bundled paths, so cross-package continuation is not guaranteed. Keep the old package/path available for old sessions rather than editing saved manifests to bypass guards.

Old OS scheduler tasks are not automatically removed. If a historical Windows runner is still registered, inspect its active work and disable it manually before using app-owned scheduling.

## Roll back

1. Disable the integration extensions (or remove only its Pi package declaration with `pi remove <source>` in the correct scope).
2. Re-enable the previous standalone extension resources.
3. Reload/restart and confirm only one owner per tool name.

Do not delete shared schedules/native sessions/logs as part of rollback. No rollback can undo completed tool side effects, and cancellation does not establish arbitrary descendant-process termination.
