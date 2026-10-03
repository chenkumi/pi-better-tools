# Configuration compatibility

No settings are renamed or automatically migrated. These namespaces are module identities, not the root package name.

| Module | Debug setting | Setting source | Diagnostic location |
| --- | --- | --- | --- |
| Subagents | `pi-subagents.debugLog` | global agentDir/settings.json; honors `PI_CODING_AGENT_DIR`, reread per call | `~/.pi/logs/pi-subagents/` |
| Shell | `pi-shell-tools.debugLog` | fixed `~/.pi/agent/settings.json`, reread on failure | `~/.pi/logs/pi-shell-tools/` |
| File | `pi-file-tools.debugLog` | global agentDir/settings.json; honors agentDir override, read when extension loads | `~/.pi/logs/pi-file-tools/YYYY-MM-DD.jsonl` |
| Web | `<cwd-basename>.debugLog` | fixed `~/.pi/agent/settings.json` | `~/.pi/logs/<normalized-cwd-basename>/tool-errors-YYYY-MM-DD.jsonl` |
| Scheduler | `pi-scheduler.debugLog` | fixed `~/.pi/agent/settings.json`, reread on failure | `~/.pi/logs/pi-scheduler/` |

Debug logs are opt-in. Subagent/Shell/File diagnostics may contain prompts, commands or file content. Web/Scheduler omit tool parameters but errors can still contain sensitive information. Log retention varies by module; do not claim a shared retention policy or automatic cleanup.

## Web search

Default `~/.pi/agent/web-search.json` does not silently follow agentDir. Set an explicit absolute `PI_WEB_TOOLS_CONFIG` when isolation is needed; empty/relative overrides are invalid. Reload after changes.

```json
{ "provider": "openai", "enabled": true }
```

OpenAI credentials belong to Pi. Native search is injected only for supported provider/API gates; no same-named function tool is registered. Actual backend/auth availability is not guaranteed. Legacy Codex is experimental; virtual routing does not infer the physical provider.

```json
{ "provider": "brave", "providers": { "brave": { "apiKeyEnv": "BRAVE_API_KEY" } } }
```

For Exa, use `provider: "exa"` and `providers.exa.apiKeyEnv: "EXA_API_KEY"`. There is no implicit provider fallback. Invalid configuration disables search while leaving safe-default Fetch available. Full schema/example: `modules/web-tools/schemas/web_search.schema.json` and `modules/web-tools/examples/web-search.json`.

Chromium must be installed explicitly with `npm run browser:install`; this downloads the browser only. On Linux/WSL2, `npm run browser:install-deps` installs its OS dependencies, or `npm run setup:browser` explicitly installs both. OS dependency installation may request sudo and is never run automatically by npm install or extension loading. On macOS (Apple Silicon/Intel), use `npm run browser:install` without sudo; Linux OS dependency setup is not required. Playwright defaults to `~/Library/Caches/ms-playwright` on macOS; install as the user running Pi and keep any `PLAYWRIGHT_BROWSERS_PATH` override consistent between installation and runtime. Re-run browser installation after Playwright updates or cache/architecture changes, and check Playwright's supported macOS versions. See the root README's macOS and Linux installation sections for prerequisites, troubleshooting and limitations. No personal browser profile/cookies are used. Private/local network access, login, CAPTCHA bypass and PDF are not supported by model-callable Fetch.

## Note Tools

No settings, debug namespace or global storage. `note` accepts `{ type, content }`; the five categories map to invocation workspace directories `plan/`, `issue/`, `research/`, `report/` and `task/`. UTC timestamp filenames have uppercase category prefixes and `.md` suffixes. Contents are verbatim UTF-8, empty strings are allowed, and exclusive creation never overwrites an existing file. Collisions increment the timestamp by a millisecond (up to 1000 attempts). Returned `{ type, path, relativePath }` data is available in details and structured output. File I/O failure is an error and may leave a partial newly created file; cancellation is checked before writing, not used to interrupt or undo a started write.

Select/filter `modules/note-tools/extensions/note.ts` with the usual Pi package filters. Include `note` in explicit tool allowlists; exclusion/read-only/no-tools stay authoritative. No automatic settings migration or forced changes to Pi's active tool selection are performed. Existing directory symlinks/junctions follow OS semantics, not a sandbox boundary.

## GPT Speed

Native entry: `modules/gpt-speed/extensions/gpt-speed.ts`; commands `/fast`, `/ultrafast`, `/normal` directly select a mode, not a toggle. No model-callable tools or extra CLI flags. `pi-gpt-speed.mode` accepts `normal | fast | ultrafast`, defaults to `normal`. Read global `<getAgentDir()>/settings.json` on session start/reload, then apply a valid `<cwd>/.pi/settings.json` mode only when `ctx.isProjectTrusted()` is true. Commands persist only the selected mode to global settings under Pi's settings lock with a read/merge/temp-write/rename; unrelated fields are preserved, corrupt JSON is not replaced. Read/write failures are reported; write failure leaves the current in-memory mode active but unsaved. Project overrides remain authoritative on the next load. No migration from `pi-codex-fast` or changes to auth.

Only `openai`/`openai-codex` and exact `gpt-<major>[.<minor>]-<luna|terra|sol|astra>` IDs with major/minor version >= 5.6 activate. Minor defaults to zero (`6` is supported); `5.10` is newer than `5.6`. Fast injects `service_tier: "priority"`; Ultrafast injects `"ultrafast"` for sol/astra, falls back to `"priority"` for luna/terra without changing the selected preference. Unsupported models/providers, non-object payloads and Normal are untouched. Normal does not delete tiers set by other extensions/providers. TUI footer shows effective speed with downgrade/inactive annotations and updates on model selection. Disable competing speed extensions. This pattern is local policy, not backend eligibility or price verification; no automatic retry/fallback for backend denial. Full contract: `modules/gpt-speed/README.md`.

## Goal

原生入口 `modules/goal/extensions/goal.ts`；不新增 settings／全域儲存／背景服務。`/goal <驗收目標>` 保存完整原文，直接 active；`status | pause | resume | clear` 管理 lifecycle，`-- ` 可輸入與操作同名的目標。Goal 與可選 plan 完全分離，不以步驟／checklist 完成判定成功。明確工具 allowlist 要加入 `goal`；exclusions／no-tools 不被繞過。`goal` 為 model-only、sequential，`get` 只讀，complete／blocked 只接受目前 owned goalId/runId 的非空驗收報告。

每次 start／resume 至多 20 次自身 continuation 提案，連續 3 次沒有文字／工具活動的自動回覆停止；沒有可配置數值、token accounting 或成本硬上限，不把非空重述視為語意進展。一般使用者訊息優先，其他 boundary handler 續跑／pending messages 不被覆蓋。初始正常 prompt 附 `[[pi-better-goal:<goalId>:<runId>]]` 保留標記，input transformers 應完整保留；它不是 objective 一部分或額外授權。

Session branch 的 `pi-better-goal-state` custom entry 是 authority；clear 寫 null tombstone，最新壞 snapshot 不略過。Reload／restore／fork／tree 的 active 先 paused，需明確 resume。cwd 不符需 clear；append fault 禁用 mutation／續跑並保留跨 reload latch，pause 仍可取消。修好儲存後從磁碟重新開啟 session；只 reload 不清除 fault。沒有 fsync 保證；in-memory session 不保證跨重啟。Goal 內容和驗收報告保存於 session，可能包含使用者／專案敏感資料，遵循現有 session 保存及備份政策。

`PI_SUBAGENTS_GUARD` 或 `PI_SCHEDULER_CHILD` 存在時，不註冊 goal tool／command／自動執行；只投影移除 inherited Goal control context。完整欄位限制、prompt admission 限制與恢復說明見 `modules/goal/README.md`。安裝前先停用其他同名 Goal extension，不遷移其儲存格式。

## JSON Schema delivery

Opt-in entry `modules/json-schema/src/index.ts`; CLI-only flags, no global settings/auth changes. `--json-schema` must be a JSON object schema with `type: "object"` and activates the feature. `--json-output <path>` selects file delivery; without it the result goes to stdout. Relative paths resolve from the working directory and missing parent directories are created. File output is a same-directory temporary file plus atomic rename; a failed run keeps the previous file, but always check the exit status.

stdout delivery supports print mode with exactly one ordinary prompt: one compact UTF-8 JSON line after the run, diagnostics on stderr (prefix `pi-json-schema:`), nonzero exit on failure. TUI/RPC/`--mode json` are rejected before any model request. Assistant text blocks of final messages are removed in this automation mode so stdout carries only the result. Separate stdout from stderr and inspect the exit code before parsing.

Fallback is always best-effort: parse the last assistant message's JSON and validate; otherwise one extra model extraction request (60 seconds, no retries) using the model that actually answered. A disabled `json_output` tool blocks the extraction request, not validation of direct text JSON. Invalid results, no result, error/aborted runs, SIGTERM and conflicting repeated results fail without delivering anything. The extension never calls `process.exit()`. Extraction usage is not added to session totals. Supported schema scope and caveats: `modules/json-schema/README.md`.

## Persistent state

Every new Subagent task automatically persists under `<agentDir>/subagent-sessions/<ULID>/` (manifest, native `pi/`, readable transcript and `runs/`). The `resumable` tool parameter and non-persistent dispatch mode were removed; only verified ready sessions can resume. Old `sub-sessions/v2` logs are preserved as historical data, not migrated into native sessions. Subagent logs/native sessions use Pi's agentDir. Scheduler uses `PI_AGENT_DIR` when set, otherwise `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`; state remains under `pi-scheduler/`. Set both overrides consistently for legacy isolated hosts. Its debug logs intentionally still use the fixed home path.

Do not modify existing registry/native sessions during installation. Back up state before manual repair. Moving bundled agent source paths may make prior managed sessions non-resumable; do not bypass fingerprint/trust checks.
