# Install, migrate and roll back

## Before enabling the integration

1. Back up the relevant Pi settings file. Review `pi list` and `pi config` in both personal/project scopes.
2. Disable the extension resources of the old five standalone packages and pi-pty-terminal. Preserve their folders, credentials and persistent state. Different package identities do not deduplicate same-named tools.
3. In this repository run `npm ci --ignore-scripts`, `npm run pty:install` and `npm run build`; install Chromium explicitly if Fetch is needed.
4. Run `pi install D:/projects/pi-better-tools`, or use `-l` for the intended project. Project packages require the existing trust policy; do not enable automatic approve just to avoid errors.
5. Reload/restart Pi. Check the loaded tools, and `/web-tools status`.

No script here automatically changes user settings/auth, deletes logs, removes old packages or edits data left behind by the removed Scheduler module.

## Local-source extensions and Blackhole vendoring

The root pins pi-open-tui 0.3.11 and @ff-labs/pi-fff 0.11.0 as npm dependencies. Blackhole is now the local 0.5.12 snapshot in `modules/blackhole/`, replacing npm pi-blackhole 0.5.11. The manifest loads twelve local TS entries and two npm entries (fourteen total). Run `npm ci --ignore-scripts` only at the repository root; no nested install, plugin manager or automatic Pi install is introduced. Upstream nested metadata/scripts are historical; root Pi 1.1.0 remains authoritative.

For an existing pi-better-tools source mount, the root manifest change is sufficient: do not add another global/project Blackhole entry. Reload/restart after current background work has settled. Existing standalone `npm:pi-blackhole`, pi-open-tui and pi-fff resources must be disabled manually if still selected. This repository does not edit real settings/auth or remove installed standalone packages.

**Review Blackhole filters:** replace `node_modules/pi-blackhole/dist/index.js` resource references with `modules/blackhole/src/index.ts` when opting in/out. An exclusion on the old path does not exclude the new entry. Never select both `modules/blackhole/index.ts` and its forwarding `src/index.ts`. Personal `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`, observations/reflections and raw sessions keep their existing locations; no state migration or old-session display-copy backfill occurs.

The current Pi-owned mode supersedes Blackhole before-request/admission, final-only and minimal-tail cut policies; old descriptions/logs remain historical evidence, not present guarantees. Pi controls triggering, preparation/cut/tokensBefore, persistence and retry/cancel; Blackhole only supplies the native hook summary, without modifying Pi or wrapping requests. It does not prohibit native final threshold or callback replay. Existing compaction:auto plus compactionEngine:blackhole only selects summary participation; this cleanup adds no adoption/timing key, .pi/global edit or automatic personal settings migration. Deprecated BH timing/tail knobs do not change native boundaries, and Pi reserve/keepRecent/modelOverrides remain user-managed. With `showPreCompactionMessage: true`, future successful Blackhole compactions can persist only the newest actually omitted assistant text for resume display (not model context); an already retained latest final is never copied. It does not make resume a full-history viewer. Integration probes are passive/credential-isolated and offline; published upstream peer ranges or development versions are not evidence for other host versions.

### Blackhole ignored-control cleanup (limited Review 4 snapshot)

New scaffold and explicit global/project/session Save omit `compactAfterPreset`, `compactAfterTokens`, `compactAfterRatio`, `compactReserveTokens`, `midRunCompaction`, `tailBehavior`, `retainedToolOutputMaxTokens`. Read/load/reload does not rewrite existing files or old session JSONL; legacy UI rows are readonly compatibility explanations. Preserve unrelated unknown keys, untouched model metadata, user `compactAfterPresets` definitions, effective memory/debug/recall/output budgets, `debug`, `sessionFallback`, `fullFoldAlways` and configured models/fallbacks. Do not bulk-delete `passive`, `noAutoCompact` or `overrideDefaultCompaction`: exact semantic conversion and canonical/false/env/session precedence are separate work. Physical cleanup requires an exact backup and explicit approval, not automatic install/reload migration. This root documentation round does not inspect or edit personal files.

Session overrides follow the actual persisted record's current-branch ancestry; Reset/public session delete appends an empty branch-local record rather than erasing history. Successful Reset or Global/Project Delete synchronizes fresh lower-layer display and Save buffers, so explicit Save can recreate a deleted file without restoring stale untouched fields. Cancellation, callback/unlink refusal and failed writes preserve dirty edits; no cross-writer atomicity or rollback is promised. Warning dedup requires public hasUI true and successful callable notification; native capacity is not trigger timing, and unknown native trigger budget stays unknown. Full details: `docs/configuration.md` and the module's current local `docs/CONFIG.md`/`docs/MIGRATION-GUIDE.md` sections.

The fixed core and settings/migration snapshots have separate limited static acceptance (`report/REPORT-20261009T193032883Z.md`, `report/REPORT-20261009T200405430Z.md`); reviewers did not rerun tests or approve all 336 source files as universally safe. Historical before-request/final-only requirements and their removed normative tests remain history, not active settings, skips or restored triggers. Upstream 0.5.12 identity/MIT credits and unavailable earlier-diff warnings remain; source integrity/cross checks do not constitute full root/package, provider or release acceptance.

## Notification evidence and managed-child Shell adoption (2026-10-09)

After current work settles, reload/restart the existing local entries; no new extension, dependency, tool name, settings key or persistence migration is added. Main-agent Shell background:true/receipts/management remain. Managed owned new/resume/ready-query children with loaded Shell receive explicit shellMode:foreground-v1 in the existing guard handshake and same-name foreground-only bash/powershell definitions. Child callers must remove the background field entirely (false/null/undefined and inherited values are rejected too), use command/timeoutMs and consume the host synchronous result. Do not request Shell status/cancel there; they are not registered. Missing/legacy/unrecognized markers do not infer managed-child identity from RPC/JSON/cwd/prompt. No implicit activation or tools are added; ready-query remains no-tools and recursion exclusions stay.

Environment handshake is consumed/deleted in either load order, while the same full process-local object survives reload. Guard receipt reuse requires that same object's already-verified lease; fresh invocation still exclusive wx creates, not adoption of identical existing payload. Reload strictly rechecks configuration/trust, raw Buffer bytes, bigint file identity/size and descriptor/path timestamp checkpoints. Missing/foreign/tampered/replaced receipts fail closed with child exit1; do not delete/overwrite receipts or weaken metadata to force startup. Legacy same-process cache upgrade is only strict readonly revalidation from its saved payload, not disk/session migration. This is checkpoint observation, not atomic snapshot, filesystem lock, hard read-allocation cap, cross-process recovery or OS sandbox. Rejection precedes execution settings/backend/spawn but retains opt-in diagnostics I/O. Shell permission still allows self-created OS processes; exit/kill requests are not proof all descendants stopped.

Blackhole e:<persisted-entry-id> is additive stable-ID recall for allowlisted custom_message notifications, separate from unchanged numeric message-only #N/expand. Update callers to use query plus page, not custom-entry numeric indexing; default lineage/scope:all remain. Only selected public fields are returned, not private query/credential/raw bodies; producer-specific details own structural authority and body supplies scalar display only. Projection partial and producer outputTruncated are distinct; summary samples, selected pages and raw JSONL differ in completeness. Tiny response budgets may yield ! and structured isError diagnostics with no delivered body/cursor; 0 disables text clipping only. Unavailable means missing/excluded/ambiguous/uninspected in selected inspection, not global absence or known outcome.

New compactions may include optional insertion span/hash/refs provenance for carry/strip; Markdown headers do not authorize it. Old compactions without verified metadata are not backfilled/stripped, raw sessions remain untouched, and compaction timing/tail are unchanged. Evidence-only scanner bounds do not repair or bound legacy generic scanner/cache/lineage paths. Retrieval never replays jobs, reads transient logs, restores registries or restarts old outcome_unknown work. Offline default/append consumer probes and static review are not producer lifecycle/exactly-once/provider/manual-TUI/root-release certification. Details: `modules/blackhole/docs/recall.md`.

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

## Monitor addition

Manifest adds `modules/monitor/src/index.ts` (12 local/14 total entries, five native modules) and locked direct ws8.22 runtime dependency. Root npm ci --ignore-scripts installs it without required optional native addons. Review resource filters, then reload/restart after existing work settles; tools remain inactive unless explicitly selected. No schema change to bash/subagent, personal configuration edits or old-session migration. Managed children receive no Monitor tools. Monitor IDs/receipts are session/runtime-local; reload stops owned sources and never resurrects jobs or replays uncertain delivery. Stopping a job monitor only unsubscribes. Blackhole producer schema/fixtures are handed off separately; compaction coexistence remains unaccepted until its narrow allowlist/tests are completed. See `modules/monitor/README.md`.

## Pi Runtime addition

The manifest adds `modules/pi-runtime/src/index.ts` as a native entry. Existing source mounts load it on reload/restart unless filtered out; no automatic settings/auth edits occur. Review extension filters if bounded diagnostic recovery is not desired, or use `/runtime-recovery off` for the current session/branch. Automatic recovery is limited to explicit input errors; policy/unknown failures require `/runtime-recover` and UI confirmation, not an unconditional retry. Recovery may incur model cost; state persists inside the existing session without historical backfill or replay. See the module README before changing recovery policy.

## Module/resource selection

Use `pi config` or a package entry's `extensions`/`prompts` filters. Paths are relative to the integration root (`modules/...`). Tool activation/exclusions are separate from extension entry filters.

## Unified TypeScript entry points

All twelve local public Pi entries now use `modules/<name>/src/index.ts`. If package resource filters or explicit `-e` paths referenced `extensions/...` or JSON Schema's root `index.ts`, update them manually to the matching new path. This repository does not rewrite personal/project settings. Exclusion filters referencing an old path no longer exclude the new entry; review filters before reload. Do not load both an old implementation entry and its new forwarding entry, as that registers tools/hooks twice.

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

停用獨立 `pi-pty-terminal`，只載入整合入口 `modules/pty-terminal/src/index.ts`。原七個工具保留，spawn target 預設 local；新增 `pi-pty-terminal.targets` named WSL/SSH settings，不自動寫設定或搬移 session。原生 dependency setup 在 ignore-scripts 安裝後需明確 `npm run pty:install`；此步驟只執行 node-pty lifecycle，不啟動遠端連線或下載 Chromium。跨平台不可共用 node_modules。

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

Tool names, settings keys, storage directories and trust semantics are unchanged; these are fixes whose observable behaviour differs from before (details in each module README and `report/REPORT-20261009T211201258Z.md`).

- Project trust: Blackhole reads its project layers (`.pi/pi-blackhole-config.json`, legacy `.pi/settings.json`) only when `ctx.isProjectTrusted()` is `true`; Schedule Prompt starts project jobs only when trusted, and its child sessions share one trust-aware SettingsManager. A missing or throwing trust probe fails closed.
- Blackhole: `/blackhole settings` (and `configure`/`changelog`) return text outside the TUI instead of hanging; `om-on`/`om-off` patch only the `memory` key of the global file; same-session tree navigation fences stale background workers.
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
