# Install, migrate and roll back

## Before enabling the integration

1. Back up the relevant Pi settings file. Review `pi list` and `pi config` in both personal/project scopes.
2. Disable the extension resources of the old five standalone packages, pi-pty-terminal, pi-sqlite-tools and pi-sql-connector. Preserve their folders, credentials and persistent state. Different package identities do not deduplicate same-named tools.
3. In this repository run `npm ci --ignore-scripts`, `npm run pty:install` and `npm run build`.
4. Run `pi install D:/projects/pi-better-tools`, or use `-l` for the intended project. Project packages require the existing trust policy; do not enable automatic approve just to avoid errors.
5. Reload/restart Pi. Check the loaded tools, and `/web-tools status`.

No script here automatically changes user settings/auth, deletes logs, removes old packages or edits data left behind by the removed Scheduler module.

## Published-package setup and HTTP compatibility

`web_fetch` is now a basic static HTTP fetch; the Playwright/Chromium path, `waitForSelector`, `fetch.channel`, `fetch.idleTimeoutMs` and the Settings panel Chromium download were removed. The `playwright` dependency, `pi-better-tools browser *` CLI commands, `npm run browser:install`/`browser:install-deps`/`setup:browser` and web-tools `scripts/compat.mjs` were removed too. Delete `fetch.channel`/`fetch.idleTimeoutMs` from `web-search.json` (unknown fields are rejected); other settings and tool arguments need no migration.

Use the installed instance's `pi-better-tools doctor` or `pty setup`. A package bin is not guaranteed on PATH for Pi-managed/source installs; use the current Node + absolute `setup/cli.mjs` command printed by errors or identify the actual installed package root. No repository checkout/cwd is required; do not run npx to fetch another version. Root npm setup scripts remain developer aliases. PTY setup respects consumer native-script policy. `/skill:pi-tools-config` contains self-contained installation instructions even when the skill directory is relocated. Settle current jobs before reloading changed extensions.

## SQL Connector integration

Disable the standalone pi-sql-connector extension before enabling `modules/sql-connector/src/index.ts`. Root install supplies the pinned drivers; retain the target project's trusted `.pi/agent/sql-connector.json` and password environment references without copying the source project's settings. Search the configured engine (`mysql`, `mssql`, `pgsql`) with tool_search. Only configured engines register tools. `/sql-connector-reload` remains available. Windows Authentication requires explicit `npm rebuild msnodesqlv8 --foreground-scripts` in the package root and the matching system ODBC driver; no native/system setup runs at reload. Existing SQLite configuration remains independent.

## SQLite Tools integration

SQLite is included at `modules/sqlite-tools/src/index.ts`; disable the standalone pi-sqlite-tools extension before reload to avoid duplicate tool names. Keep existing `SQLITE_PATH` or trusted project `.pi/agent/sqlite.json`; no config/database copy is required. Use `tool_search` query `sqlite` to load its deferred tools. Fixed mode still omits open/close. This package does not change personal settings or read the source project's configuration.

## Local-source extensions

The root pins @ff-labs/pi-fff as an npm dependency; pi-open-tui was removed and replaced by the native Pi Custom Panel module (prompt glyph editor and two-row footer; `/open-tui` and its telemetry, thinking peek and icon settings are not carried over). Run `npm ci --ignore-scripts` only at the repository root; no nested install, plugin manager or automatic Pi install is introduced. Upstream nested metadata/scripts are historical; the root Pi pin remains authoritative.

For an existing pi-better-tools source mount, the root manifest change is sufficient. Reload/restart after current background work has settled. Existing standalone `npm:pi-open-tui` and pi-fff resources must be disabled manually if still selected. This repository does not edit real settings/auth or remove installed standalone packages.

**Blackhole was removed (2026-11-04):** `modules/blackhole/` (the 0.5.12 snapshot), its tests, the `test:heavy:blackhole` group and the `blackhole` reference page of the `pi-tools-config` skill no longer exist; Pi Auto Compact is the only compactor in this package. If a Pi settings file still lists `modules/blackhole/src/index.ts` (or `npm:pi-blackhole`), remove that entry. The personal files (`~/.pi/agent/pi-blackhole/`, its memory state and old sessions) are not touched by this repository; old compaction entries produced by Blackhole stay in the sessions and are read as ordinary compaction summaries.

## Notification evidence and managed-child Shell adoption (2026-10-09)

After current work settles, reload/restart the existing local entries; no new extension, dependency, tool name, settings key or persistence migration is added. Main-agent Shell background:true/receipts/management remain. Managed owned new/resume/ready-query children with loaded Shell receive explicit shellMode:foreground-v1 in the existing guard handshake and same-name foreground-only bash/powershell definitions. Child callers must remove the background field entirely (false/null/undefined and inherited values are rejected too), use command/timeoutMs and consume the host synchronous result. Do not request Shell status/cancel there; they are not registered. Missing/legacy/unrecognized markers do not infer managed-child identity from RPC/JSON/cwd/prompt. No implicit activation or tools are added; ready-query remains no-tools and recursion exclusions stay.

Environment handshake is consumed/deleted in either load order, while the same full process-local object survives reload. Guard receipt reuse requires that same object's already-verified lease; fresh invocation still exclusive wx creates, not adoption of identical existing payload. Reload strictly rechecks configuration/trust, raw Buffer bytes, bigint file identity/size and descriptor/path timestamp checkpoints. Missing/foreign/tampered/replaced receipts fail closed with child exit1; do not delete/overwrite receipts or weaken metadata to force startup. Legacy same-process cache upgrade is only strict readonly revalidation from its saved payload, not disk/session migration. This is checkpoint observation, not atomic snapshot, filesystem lock, hard read-allocation cap, cross-process recovery or OS sandbox. Rejection precedes execution settings/backend/spawn but retains opt-in diagnostics I/O. Shell permission still allows self-created OS processes; exit/kill requests are not proof all descendants stopped.

Bundled reviewer now selects note and no write/edit: full review reports must be saved only by native note, then return one verdict and actual auto-generated path under150 words. Failed/unavailable note is blocked with no shell/write fallback. User/project same-name reviewer overrides remain authoritative and need manual alignment. Changed bundled agent fingerprints can reject old sessions with CONFIG_CHANGED; keep old definitions or create an explicit new handoff, never edit saved fingerprints to bypass guards.

## Pi 1.1.0 development upgrade

根四個 Pi devDependencies／唯一 lockfile 現固定為 1.1.0。根目錄執行 `npm ci --ignore-scripts`；本專案不修改真實全域 Pi 安裝、auth、trust 或 settings。先等背景工作完成再 `/reload`／重啟。

File Tools 現覆寫 `read/write/edit/ls` 四工具；`ls` 沿用 host factory及 `defaultActive:false`。已移除 `grep/find` 註冊及五行 grep 預覽。要使用 FFF 同名搜尋，全域 `<agentDir>/pi-fff.json` 設 `{"mode":"override"}`；當前或已保存 session 可執行 `/fff-mode override` 後 `/reload`。FFF schema不是host schema別名，原先 grep 的 ignoreCase/literal 參數須依新schema調整。未選override的使用者仍可選host搜尋；套件不自動改寫全域設定。`read` 同步 outputSchema/structuredContent：codemode 的文字結果仍含專案行號與 metadata；圖片改為 host-compatible image block，可傳給 `image()`。

1.0.0 → 1.1.0 也包含 host `durationMs/outputPad`、shell recorded elapsed-time、使用者限定 output files 與 codemode 圖片／輸出修正；使用 host definitions 的部分隨 SDK 載入，不複製 host 私有程式。`agent_settled` 新增 `aborted`，既有 hooks 不更名。`--tools` 新增 `+name/-name` 與 wildcard 選取由 host 處理，不改 child allowlist builder 或保存資料身份。Subagents durable `hostContract: "0.99.1"` 仍不變。

以下為保留的 1.0.0 導入背景，不是目前支援矩陣。

## Pi 1.0.0 development upgrade (historical)

根四個 Pi devDependencies 與唯一 lockfile 固定為 1.0.0；在根目錄執行 `npm ci --ignore-scripts`、`npm run build`，不要依 modules 的歷史 manifests 個別安裝。Runtime 仍由 host 提供 Pi peers；不修改使用者真實 Pi 安裝、auth、trust 或排程。

九個 extensions 使用的 hooks 不需要更名。Pi 1.0.0 預設 fullscreen；如需舊 UI 可自行用 `--tui-mode regular`，本專案不自動改設定。`/reload` 啟用新加入 defaultTools 的工具，但移除 defaults 不會停用已 active 工具；需要撤權使用工具排除／明確 allowlist，而非僅改 defaultTools。`defaultTools: ["read"]` 也不抑制 default-active extension tools；唯讀使用 `--tools read`。

保存資料不遷移：Subagents `hostContract: "0.99.1"` 保留。升級 SDK 不允許直接把 durable format 字串換為 1.0.0；已有 managed sessions 仍依原 owner／fingerprint／guard 驗證。

## Fork addition

Manifest adds `modules/fork/src/index.ts` (14 local/16 total entries, seven native modules). No new runtime dependency (`ulid` is already a root dependency). The Subagent argument builder now also excludes `fork,fork_status,fork_cancel`; Shell/Subagents readonly capability providers gained an optional count-only callback. Entry filters that exclude native modules by path should add `./modules/fork/src/index.ts` handling; excluding the module in one project while using it in another is not a supported topology (see `modules/fork/README.md`). The tools are inactive until selected.

## Monitor addition

Manifest adds `modules/monitor/src/index.ts` (12 local/14 total entries, five native modules) and locked direct ws8.22 runtime dependency. Root npm ci --ignore-scripts installs it without required optional native addons. Review resource filters, then reload/restart after existing work settles; tools remain inactive unless explicitly selected. No schema change to bash/subagent, personal configuration edits or old-session migration. Managed children receive no Monitor tools. Monitor IDs/receipts are session/runtime-local; reload stops owned sources and never resurrects jobs or replays uncertain delivery. Stopping a job monitor only unsubscribes. See `modules/monitor/README.md`.

## Pi Runtime addition

The manifest adds `modules/pi-runtime/src/index.ts` as a native entry. Existing source mounts load it on reload/restart unless filtered out; no automatic settings/auth edits occur. The module's error recovery (`/runtime-recovery`, `/runtime-recover`) was later removed; the entry now only provides deferred-tool discovery and cross-module prompt rules.

## Skill Tools addition (2026-10-12)

新增 `modules/skill-tools/src/index.ts`，透過原生 `resources_discover` 提供封裝在 `modules/skill-tools/skills/` 的 skills。`create-plan` 在本次明確授權下由 `~/.agents/skills/create-plan/` 原樣搬入，避免保留同名全域副本。既有 root source mount 在工作結束後 `/reload`／重啟即可；若 extension filters 使用 allowlist，加入這個入口。

使用 `/skill:create-plan <需求>`；停用時排除該 extension，而非使用 package `skills: []` 或 `--no-skills`（後兩者只控制一般 discovery，不阻止 extension 提供資源）。Module 單獨可用 `pi -e ./modules/skill-tools/src/index.ts`。若需回退，先停用 extension，再將 `skills/create-plan/` 移回 `~/.agents/skills/`，不要兩份同時啟用。安裝／reload 不自動搬移 home 資料，不改 settings、auth 或 trust。

## Module/resource selection

Use `pi config` or a package entry's `extensions`/`prompts` filters. Paths are relative to the integration root (`modules/...`). Tool activation/exclusions are separate from extension entry filters.

## Unified TypeScript entry points

All thirteen local public Pi entries now use `modules/<name>/src/index.ts`. If package resource filters or explicit `-e` paths referenced `extensions/...` or JSON Schema's root `index.ts`, update them manually to the matching new path. This repository does not rewrite personal/project settings. Exclusion filters referencing an old path no longer exclude the new entry; review filters before reload. Do not load both an old implementation entry and its new forwarding entry, as that registers tools/hooks twice.

No module needs a build; `/reload` or restart loads the TS sources. No persistent data or bundled-agent paths are moved.

## Subagent persistence API change

All initial single/parallel/chain tasks create managed native sessions automatically. Remove `resumable: true` or `resumable: false`; the removed parameter is explicitly rejected. `subagent` now creates only: its `resume` parameter is removed and old continuation calls must migrate to `subagent_message`.

```text
Before: subagent({ resume: "<session ID>", task: "<new work>" })
After:  subagent_message({ subagentSessionId: "<session ID>", message: "<new work>" })

Before: subagent_message({ jobId: "<job>", taskId: "<task>", mode: "control", message: "..." })
After:  subagent_message({ subagentSessionId: "<session ID>", message: "..." })
```

`mode` defaults to control; add `mode:"query"` for a live-only read-only snapshot request. An optional display `title` belongs on the message call. Do not transfer old `background`, agent, cwd, model/provider/thinking or trust overrides to the message tool: continuation is always asynchronous and uses saved configuration.

Successful background creation returns each real managed session ID before returning the queued receipt, even for not-yet-started chain items. Log paths still appear only when the logs exist. Session identity is not readiness: queued/startup/finalizing/canceling/busy states refuse messages without a waiting queue. The message tool selects live control or verified-ready continuation automatically and returns the selected action. Continuation keeps the session ID, starts a new invocation and returns new job/task IDs; callers that previously awaited synchronous resume must handle its acceptance receipt and later task_result followUp instead.

Update explicit parent tool allowlists to include `subagent_message` where continuation is needed; this tool now has invocation-starting capability. The repository never edits real loadouts/settings or implicitly enables it. Query does not revive mainline work. Failure/cancellation does not grant resumability: only an eligible verified checkpoint can continue. Unknown delivery is not permission to repeat the same instruction. Reload/restart Pi to refresh schemas and prompt guidelines after existing jobs settle.

This change also updates the bundled worker definition and orchestration prompts. Sessions saved with the previous bundled worker fingerprint may be refused with `CONFIG_CHANGED`, even when a prior result said `canResume:true`. This is intentional saved-configuration validation, not an automatic migration: use a new session with an explicit handoff when the old definition cannot be retained; do not alter saved fingerprints to bypass guards. User-defined agents with unchanged paths/content still undergo the same validation.

Existing managed sessions retain their format and guards, but old ephemeral logs cannot be resumed or reconstructed into native history. No log/session conversion or cleanup runs during upgrade. Persistent storage is now required for every dispatch; metadata/transcript creation failures refuse execution rather than falling back to a no-session child.

## Goal removal

本整合包已移除 Goal 模組，不再提供 `/goal` 指令、`goal` 工具或自動續跑。更新後請 `/reload` 或重新啟動 Pi；若個人／專案 settings 的 resource filters、`-e` 路徑或工具 allowlist 仍指向 Goal，請手動移除。Repository 不會自動修改使用者設定。

既有 sessions 的 `pi-better-goal-state` entries 與歷史工具結果保留，不遷移、重播或刪除；移除模組不會還原既有專案修改。

## JSON Schema integration

Disable the standalone `@nqbao/pi-json-schema` before loading `modules/json-schema/src/index.ts`; the same tool and flag names are not safe to load twice. No source-project, settings or auth files are edited automatically.

The module is now a project-native rewrite (zod 4 replaces Ajv), not a snapshot of 0.1.1. Differences a script author will notice: only `--json-schema` and `--json-output` exist (`--json-output` selects file delivery, otherwise stdout); `--json-delivery` and `--json-fallback` were removed and the fallback is always best-effort (the `force` mode is gone); schemas using `if/then/else`, `not`, `dependent*`, external `$ref` or typeless type-specific constraints are rejected at startup. Explicit tool allowlists must include `json_output`; exclusions and no-tools stay authoritative. Full contract: `modules/json-schema/README.md`.

## PTY integration

停用獨立 `pi-pty-terminal`，只載入整合入口 `modules/pty-terminal/src/index.ts`。原七個工具保留，spawn target 預設 local；新增 `pi-pty-terminal.targets` named WSL/SSH settings，不自動寫設定或搬移 session。原生 dependency setup 在 ignore-scripts 安裝後需明確使用安裝實例的 `pty setup` CLI（repository 別名 `npm run pty:install`）；此步驟只執行 node-pty lifecycle，不啟動遠端連線或下載 Chromium。跨平台不可共用 node_modules。

現有 PTY session 無法跨 extension reload/移轉恢復；先完成工作或明確關閉。Windows kill/shutdown 不傳 POSIX signal；WSL/SSH kill 是 transport 關閉，不保證遠端背景程序停止。完整 target 路徑、env、SSH prerequisites 見 `modules/pty-terminal/README.md`。

## 2026-10 model-visible contract changes

These slim model-visible output and schemas; tool names, settings keys, storage directories and trust semantics are unchanged except where stated. Scripts or prompts that parse old output must be updated.

- File Tools: `read` output no longer carries a `LINE_PREFIX` marker, metadata is a single line, `edit` returns a compact patch, `write` returns no `details` payload; error recovery text points to shell. Descriptions/schemas/guidelines are de-duplicated.
- Shell Tools: background `shell_job_status` omits `jobId` to list jobs and returns new status/list fields; output keeps a tail ring buffer (`MAX_RAW_CAPTURE_BYTES` 8192); `compactJob` text is shorter; the receipt wording is decided dynamically from `getActiveTools`. `timeoutMs` remains the output-stall deadline.
- Subagents: `subagent_status` omits `jobId` to list jobs; outputSchema is a Union; `finalLogPath` is returned; capacity errors carry the submitted payload; foreground results include `structuredContent`; receipts/notifications are slimmer; bundled agents and prompts state an output contract. `hostContract: "0.99.1"` is unchanged.
- Web Tools: **`web_search` no longer accepts a `provider` argument** (provider is chosen by configuration only; legacy `provider` arguments are dropped, not rejected). Errors include a next-step hint; description/guidelines are dynamic.
- PTY Terminal: `pty_read` gains `waitFor`/`settleMs`/`format`/`since` (cursor-based re-read without drain); `pty_write` gains `keys`/`readAfterMs`; `pty_wait_exit` reports `timedOut` and an SSH 255 note; new optional `pi-pty-terminal.env.{allow,deny}` settings filter inherited local environment (default unchanged). Return text is slimmer (defaults omitted; `pty_spawn` returns `sessionId`).
- Note Tools: filenames are `TYPE-<UTC timestamp>.md` (compact UTC with milliseconds; no title or content slug); empty/whitespace content fails with `NOTE_EMPTY`; the result text has a single relative path. Existing notes are not renamed.
- JSON Schema: description merged; the README documents validation-failure semantics and provider compatibility caveats.

## 2026-10-10 defect-repair behaviour changes

Tool names, settings keys, storage directories and trust semantics are unchanged; these are fixes whose observable behaviour differs from before (details in each module README).

- Project trust: Schedule Prompt starts project jobs only when trusted, and its child sessions share one trust-aware SettingsManager. A missing or throwing trust probe fails closed.
- Schedule Prompt: child sessions await `session_shutdown`; the recursion guard recognises `custom_message` entries; error results carry `isError`; a child that aborted or errored is no longer recorded as success; non-TUI sessions get no widget or timer and use select/confirm for Jobs.
- JSON Schema: a host cancellation observed at `agent_settled` suppresses delivery (stdout empty, existing output file untouched, exit 1); after a failure, prose is still suppressed on stdout. Whether a recovered retry may be delivered stays a policy decision (not changed).
- GPT Speed: virtual (`pi-virtual`) models are always Normal; the settings lock uses the same lock identity as the host SettingsManager.
- File Tools: delegated image reads honour `images.autoResize`. Shell Tools: only the trailing host timeout diagnostic is rewritten. Note Tools: a `..archive` directory inside the workspace is no longer mistaken for an escape.
- PTY Terminal: a matcher worker releases capacity only after confirmed exit; transports left alive by a failed shutdown are parked in an in-process orphan registry and re-claimed by the same canonical owner cwd after reload (not persisted across process restarts). Subagents: argument rejections return `isError`; the project-agent confirmation receives the tool abort signal.
- Known limits kept as `todo` tests: Monitor command authorization scope, Web blind private requests (not an SSRF sandbox), Note ancestor-directory swap, `@ff-labs/pi-fff` override-mode conflicts and finder capacity/shutdown fences (upstream), duplicate-summary `session_compact` (Pi host).

## Existing data

New project-generated ULIDs use `ulid().toUpperCase()`. Managed session validation and live-log recovery still accept legacy lowercase ULIDs and lowercase UUIDs; existing identities are not case-normalized or renamed.

Debug namespaces, Web configuration and storage paths remain compatible. No schema migration or replay is performed.

Existing managed Subagent sessions can include absolute agent source paths and fingerprints. Integration packaging changes bundled paths, so cross-package continuation is not guaranteed. Keep the old package/path available for old sessions rather than editing saved manifests to bypass guards.

The Scheduler module was removed (2026-10-06; unrelated to the later Schedule Prompt module, which registers only `schedule_prompt` and `/schedule-prompt`): the `schedule_*` tools, the `/schedule` command and the `pi-scheduler` bin no longer exist. Existing Scheduler data (`<agentDir>/pi-scheduler/`, logs under `~/.pi/logs/pi-scheduler/`) is not deleted by this repository; remove it manually if unwanted. If an independent runner or an OS task from an older version is still registered, inspect its active work and disable it manually.

## Roll back

1. Disable the integration extensions (or remove only its Pi package declaration with `pi remove <source>` in the correct scope).
2. Re-enable the previous standalone extension resources.
3. Reload/restart and confirm only one owner per tool name.

Do not delete shared schedules/native sessions/logs as part of rollback. No rollback can undo completed tool side effects, and cancellation does not establish arbitrary descendant-process termination.

## Pi 1.5.2 upgrade (2026-11-10)

The four root Pi development packages, the lockfile and every real-host version assertion now target only 1.5.2; 1.5.0 is no longer verified. Runtime peers remain host-provided. Run root `npm ci --ignore-scripts` after pulling.

Changes in this repository caused by 1.5.1/1.5.2:

- **Session-affinity headers:** Pi 1.5.1 renamed them per provider API (`session-id` for OpenAI Responses and Codex, `session_id`/`x-session-affinity` for OpenAI-compatible completions, `x-session-id` for OpenRouter, `x-session-affinity` for Anthropic). The Fork child guard writes the names of the current `ctx.model.api` (all of them for an unknown API) as the parent session id; see Fork README 4a/4b.
- Measured on 1.5.2 (opencode-go/deepseek-v4.1-flash, one sample): the Fork child's first request read 46080 of 46308 tokens from cache.
- Verification run: typecheck, lint, unit, cross, integration and the heavy group. The only failing integration stage is the known-upstream `@ff-labs/pi-fff` 0.11.0 aux-finder capacity defect (D14, not caused by 1.5.2).

Separate change of the same day (not host-caused): the `note` tool lost its `checkpoint` type, and Pi Auto Compact lost its interval checkpoint (the deadline notice now asks for `progress_checkpoint`).

## Pi 1.5.0 upgrade (2026-11-03)

The four root Pi development packages, the lockfile (which adds `@earendil-works/pi-schema`) and every real-host version assertion now target only 1.5.0; 1.4.0 is no longer verified. Runtime peers remain host-provided. Run root `npm ci --ignore-scripts` after pulling.

Changes in this repository caused by 1.5.0:

- **`StringEnum` typing:** the published `pi-ai` types it as a pi-schema value, so inside a TypeBox `Type.Object` the static type collapsed to `{}`. Note, Subagents, Web and Schedule Prompt each define a small local `StringEnum` (`Type.Unsafe`) that emits the same `{ type: "string", enum }` JSON.
- **`Type`/`Static`:** no longer re-exported by `pi-ai`; Schedule Prompt imports them from `typebox`.
- **Key hints:** Shell's output renderer uses `context.keyHint` from the render context instead of importing `keyHint` (the package copy cannot see the user's keybindings). Test render contexts must provide `keyText`/`keyHint`.
- **Tool argument validation** now runs on pi-schema with loose coercion (for example a number for a string property becomes a string). No tool here uses `Type.Refine`, `BigInt`, `Undefined`, codecs or `Format.Set`; `Type.Record` (PTY `env`, SQL parameters) was checked against pi-schema and works. Validation error text the model sees changes.
- Unchanged and re-verified by the real-host groups: the `session_before_compact` event and result shape.

Not re-verified on 1.5.0: Web's measured Anthropic native-search behaviour (still the 1.4.0 observation).

## Pi 1.4.0 upgrade (2026-10-23)

The four root Pi development packages, the Shell Monitor backend gate and real-host assertions now target only 1.4.0; 1.3.0 is no longer verified. Runtime peers remain host-provided. Run root `npm ci --ignore-scripts`; no other dependency, personal Pi install, settings/auth, historical session or managed hostContract migration occurs.

Host changes that touch this package:

- Resumed sessions and `/tree` keep extension tools active when the branch recorded its loadout before they registered. The host still honors `defaultActive: false`, allowlists/exclusions and tools the branch removed, so File Tools' inactive `grep`/`find` registrations and manual deactivation are unchanged.
- Concurrent extension `select`/`confirm`/`input`/`editor` dialogs now stack instead of replacing each other. SQL Connector write confirmations rely only on the public UI context.
- `generateSummary()` ignores `reserveTokens`; `compaction.reserveTokens` only controls when compaction starts.
- Pi still drops Anthropic `server_tool_use`/`web_search_tool_result` blocks and OpenAI annotation-only URLs, so the Web Tools native-search guidance is unchanged.

## Pi 1.3.0 and dependency upgrade (2026-10-16)

The four root Pi development packages and real-host assertions now target only 1.5.0; the Shell Monitor backend gate is pinned to that installed version. Runtime peers remain host-provided. Run root `npm ci --ignore-scripts`, explicit `npm run pty:install` and `npm run browser:install` for the updated node-pty beta.15 and Playwright 1.64.1. No personal Pi install, settings/auth, historical session or managed hostContract migration occurs. TypeScript 6.0.3 (not unsupported 7.x), Node 22 types and explicit Vite for Vitest 5 are compatibility choices, not unexamined latest tags.

Reload after current work settles to load the new `monitor_event` renderer. Existing saved details/body remain readable; old wake metadata is unknown. New receipts/metadata include wakeAgent. Default true already requests an Agent followUp turn; false is model-visible data without a new turn request, and automatic Shell monitors intentionally stay false. UI rendering never changes this delivery policy.

## Pi 1.2.0 development upgrade (historical)

根四個 Pi devDependencies／唯一 lockfile 現固定為 1.2.0（`@earendil-works/chord` 不再是依賴）。`emitBeforeAgentStart(trigger, options)` 簽章更新，Shell 的 Monitor 執行閘門改為 "requires Pi 1.2.0"。不再維護 1.1.0 或更早版本；上方 1.1.0 章節保留為歷史。

- **Schedule Prompt removed (replaced by Schedule Commands):** `modules/schedule-prompt` (tintinweb/pi-schedule-prompt 0.4.1 snapshot) was replaced by the native `modules/schedule-commands`. Tool names `schedule_prompt` and `schedule_shell` stay; `/schedule-prompt` becomes `/schedule-commands`; the message type `scheduled_prompt` becomes `scheduled_command`. Storage moves to `.pi/schedule-commands.json` (version 2) and settings to `schedule-commands-settings.json`; old `schedule-prompts*.json` files are not read or migrated, so recreate jobs with the tools. `endAt` is kept and is now part of the schema.
