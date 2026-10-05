# Configuration compatibility

No settings are renamed or automatically migrated. These namespaces are module identities, not the root package name.

| Module | Debug setting | Setting source | Diagnostic location |
| --- | --- | --- | --- |
| Subagents | `pi-subagents.debugLog` | global agentDir/settings.json; honors `PI_CODING_AGENT_DIR`, reread per call | `~/.pi/logs/pi-subagents/` |
| Shell | `pi-shell-tools.debugLog` | fixed `~/.pi/agent/settings.json`, reread on failure | `~/.pi/logs/pi-shell-tools/` |
| File | `pi-file-tools.debugLog` | global agentDir/settings.json; honors agentDir override, read when extension loads | `~/.pi/logs/pi-file-tools/YYYY-MM-DD.jsonl` |
| Web | `<cwd-basename>.debugLog` | fixed `~/.pi/agent/settings.json` | `~/.pi/logs/<normalized-cwd-basename>/tool-errors-YYYY-MM-DD.jsonl` |
| Scheduler | `pi-scheduler.debugLog` | fixed `~/.pi/agent/settings.json`, reread on failure | `~/.pi/logs/pi-scheduler/` |

Web cwd basenames recognize explicit Windows drive/UNC absolute paths on all hosts; other paths follow native host semantics (including literal backslashes in POSIX filenames). NFKC/safe-character normalization, length bounds and Windows device-name protection apply before selecting the opt-in key and log directory.

Debug logs are opt-in. Subagent/Shell/File diagnostics may contain prompts, commands or file content. Web/Scheduler omit tool parameters but errors can still contain sensitive information. Log retention varies by module; do not claim a shared retention policy or automatic cleanup.

## Subagent model and thinking selection

Omit `model`, `provider` and `thinkingLevel` overrides unless explicitly requested by the user or a skill. For initial single/parallel/chain dispatch, resolve the model in the parent registry **before** checking its supported thinking levels. Unknown or ambiguous model IDs and unknown/unsupported thinking strings are ignored, not dispatch errors. An explicit `provider` only permits an exact lookup on that provider. A single model string prefers a registered `provider/model` interpretation; otherwise its complete bare ID prefers the current provider, then requires a unique registry match. For slash-containing bare IDs that collide with a registered qualified selection, add the full provider prefix to disambiguate. Canonical `provider/model` is passed to child Pi.

Ignoring an override is equivalent to omitting it: use a registered agent model or inherit the parent model. Parent-model inheritance also inherits parent thinking, normalized with the host's thinking-level helper. A valid model override or agent model without a valid thinking override omits `--thinking`, letting child Pi use its default. The thinking schema accepts a string so unknown names can reach this fallback rather than failing enum validation. Invalid parameter shapes and provider/model combinations remain subject to existing validation.

Resume accepts saved identity, a new task and an optional display-only `title`, and does not silently replace saved model configuration. Child startup guard/trust/checkpoint checks remain strict. Registry checks do not issue provider requests or validate credentials, and parent-only provider registrations may still be unavailable in the child. No settings or auth files are changed.

## Subagent display title

Optional `title` describes the subagent's work in at most 50 Unicode code points, not UTF-16 code units (combined emoji/accents can contain multiple code points). Single/resume use the top-level field; parallel/chain items accept their own title, falling back to a top-level batch title. Blank/control-only titles, over-50-code-point titles and raw UTF-8 over 4 KiB are rejected before dispatch. Runtime repeats the length check because host schema counters can group some combining sequences. Normal Pi argument normalization remains unchanged: optional null can be omitted and number/boolean can become strings; direct execute rejects non-string titles. Call, running and final TUI displays retain agent identity and show sanitized titles; old calls/results without titles retain their former display. Title stays in parent tool arguments/details, never replaces `task`, enters child argv/prompt, or changes the saved managed configuration. Resume requires a fresh optional title; it does not read one from prior runs. Reload to activate the schema/renderer changes; no new settings.

## Background execution and interaction

No new global settings or service. `background` is an optional boolean on `bash`, `powershell` and `subagent` (including resume); omission/false preserves synchronous execution. Reload the extensions after local changes; reload, exit and session replacement cancel jobs and discard old-owner notifications. Embedded SDK hosts must await `AgentSessionRuntime.dispose()`; directly disposing only the session does not emit extension shutdown. Cancellation requests cannot guarantee process-tree or provider-side termination.

- Shell acceptance returns `{jobId,status:"running",liveLogPath}`, without a pretend exit code. `shell_job_status` / `shell_job_cancel` accept `{jobId}` and are `defaultActive:false`: select them explicitly in the loadout, `defaultTools` or `--tools`. No tool selection is forced. Logs are session-local temporary files (1 MiB cap), removed on eviction/shutdown; output may be truncated and sensitive. Eight active jobs and 32 retained records bound memory/resource use.
- Subagent acceptance returns a job with per-task IDs/status. Allocation later supplies `subagentSessionId` and `liveLogPath`; queued/chain tasks report `logPending` until those resources really exist. `subagent_status` / `subagent_cancel` accept `{jobId}`; `subagent_message` accepts `{jobId,taskId,mode:"control"|"query",message}`. Explicit tool allowlists must include the desired management tools; read-only/no-tools/exclusions remain authoritative. Children exclude all four subagent tools. Up to 32 submitted tasks process-wide share the existing eight active-child permits; 64 retained jobs.
- Read logs with existing `read`, not a new inspect tool. Managed `runs/<taskId>/transcript.jsonl.partial` stays constant during execution, renames to same-directory `transcript.jsonl`, and completed result points to the conversation aggregate. Only missing managed `.partial` paths receive advisory retry/wait guidance. No automatic target substitution, permission-error inference or completion inference; aggregate offsets differ from run offsets.
- Task/query results are custom model-visible `followUp` messages with `triggerTurn:true`, not system-role instructions. Busy agents queue the result; idle agents continue automatically. `sendMessage()` has no delivery acknowledgement; status remains the result authority. Background subagent/query usage is reported separately, not settled into host session totals.
- Control is literal delegated user input, FIFO at assistant/tool boundaries, never a tool interrupt. `accepted` / `queued` do not establish `applied`; transformed/unmatched canonical input can be `delivery_unknown` and must not be blindly resent. Query runs a tool-free ephemeral in-memory snapshot request using the child's verified model/config; neither question nor answer enters its mainline. A safe-prefix snapshot may lag a running tool. Each query is bounded to 30 seconds / 2048 requested output tokens / 64 KiB streamed output, with separate usage and best-effort abort; no fallback to parent credentials/model.

Complete contracts and additional limits: `modules/subagents/README.md`, `modules/shell-tools/README.md`. New interactive/background behavior is tested on offline Pi 1.0.0 only; 0.99.1/0.99.2 and real providers have not been verified. Ordinary print-mode CLI shutdown cancels pending jobs; use interactive/RPC or a live SDK runtime when results need to return later.

## Web search

Default `~/.pi/agent/web-search.json` does not silently follow agentDir. Set an explicit absolute `PI_WEB_TOOLS_CONFIG` when isolation is needed; empty/relative overrides are invalid. Reload after changes.

```json
{ "provider": "openai", "enabled": true }
```

OpenAI credentials belong to Pi. Native search is injected only for supported provider/API gates; no same-named function tool is registered. Actual backend/auth availability is not guaranteed. The `openai-codex`/`openai-codex-responses` pair is enabled by default without an extra opt-in or experimental warning. The removed `providers.openai.experimentalCodex` field must be deleted from old config files before reload; unknown fields remain invalid. Configuration errors and unsupported-model diagnostics are retained. Virtual routing does not infer the physical provider.

```json
{ "provider": "brave", "providers": { "brave": { "apiKeyEnv": "BRAVE_API_KEY" } } }
```

For Exa, use `provider: "exa"` and `providers.exa.apiKeyEnv: "EXA_API_KEY"`. There is no implicit provider fallback. Invalid configuration disables search while leaving safe-default Fetch available. Full schema/example: `modules/web-tools/schemas/web_search.schema.json` and `modules/web-tools/examples/web-search.json`.

Chromium must be installed explicitly with `npm run browser:install`; this downloads the browser only. On Linux/WSL2, `npm run browser:install-deps` installs its OS dependencies, or `npm run setup:browser` explicitly installs both. OS dependency installation may request sudo and is never run automatically by npm install or extension loading. On macOS (Apple Silicon/Intel), use `npm run browser:install` without sudo; Linux OS dependency setup is not required. Playwright defaults to `~/Library/Caches/ms-playwright` on macOS; install as the user running Pi and keep any `PLAYWRIGHT_BROWSERS_PATH` override consistent between installation and runtime. Re-run browser installation after Playwright updates or cache/architecture changes, and check Playwright's supported macOS versions. See the root README's macOS and Linux installation sections for prerequisites, troubleshooting and limitations. No personal browser profile/cookies are used. Private/local network access, login, CAPTCHA bypass and PDF are not supported by model-callable Fetch.

## Tool TUI rendering

The original 20 interactive function tools have call/result renderers, including delegated host renderers. File errors show operation/code/message/recovery; successful read and image handling remain host-provided. Write success shows bytes with path/hash on expansion. Note previews category/first line instead of the full document. Scheduler summarizes revision, exact next time/timezone, host warnings and history; cancellation stays a request, not confirmed termination. Web summarizes sources, warnings and truncated-output paths; expansion shows external/untrusted text. The seven PTY tools summarize session/target/local transport PID, bounded terminal text and transport exit/timeout/release; ANSI/control sequences are stripped only for display, write input and spawn args/env are not previewed, and remote process-tree termination is never inferred. Renderers do not change model-visible content/details/structuredContent, activation, trust or tool execution. No new settings are required; reload the extension to load local changes. The five added background management/interaction tools have bounded, control-safe call/result renderers, hide submitted control/query text and never infer process-tree termination. Print-only `json_output` deliberately has no TUI renderer; OpenAI native search is not a Pi function tool.

## Note Tools

No settings, debug namespace or global storage. `note` accepts `{ type, content }`; the five categories map to invocation workspace directories `plan/`, `issue/`, `research/`, `report/` and `task/`. UTC timestamp filenames use `<TYPE>-YYYYMMDDTHHmmssSSSZ.md` (for example `REPORT-20261003T072258503Z.md`), preserving millisecond precision and lexical time order. Existing notes are not renamed. Contents are verbatim UTF-8, empty strings are allowed, and exclusive creation never overwrites an existing file. Collisions increment the timestamp by a millisecond (up to 1000 attempts). Returned `{ type, path, relativePath }` data is available in details and structured output. File I/O failure is an error and may leave a partial newly created file; cancellation is checked before writing, not used to interrupt or undo a started write.

Select/filter `modules/note-tools/extensions/note.ts` with the usual Pi package filters. Include `note` in explicit tool allowlists; exclusion/read-only/no-tools stay authoritative. No automatic settings migration or forced changes to Pi's active tool selection are performed. Existing directory symlinks/junctions follow OS semantics, not a sandbox boundary.

## GPT Speed

Native entry: `modules/gpt-speed/extensions/gpt-speed.ts`; commands `/fast`, `/ultrafast`, `/normal` directly select a mode, not a toggle. No model-callable tools or extra CLI flags. `pi-gpt-speed.mode` accepts `normal | fast | ultrafast`, defaults to `normal`. Read global `<getAgentDir()>/settings.json` on session start/reload, then apply a valid `<cwd>/.pi/settings.json` mode only when `ctx.isProjectTrusted()` is true. Commands persist only the selected mode to global settings under Pi's settings lock with a read/merge/temp-write/rename; unrelated fields are preserved, corrupt JSON is not replaced. Read/write failures are reported; write failure leaves the current in-memory mode active but unsaved. Project overrides remain authoritative on the next load. No migration from `pi-codex-fast` or changes to auth.

Only `openai`/`openai-codex` and exact `gpt-<major>[.<minor>]-<luna|terra|sol|astra>` IDs with major/minor version >= 5.6 activate. Minor defaults to zero (`6` is supported); `5.10` is newer than `5.6`. Fast injects `service_tier: "priority"`; Ultrafast injects `"ultrafast"` for sol/astra, falls back to `"priority"` for luna/terra without changing the selected preference. Unsupported models/providers, non-object payloads and Normal are untouched. Normal does not delete tiers set by other extensions/providers. TUI footer shows effective speed with downgrade/inactive annotations and updates on model selection. Disable competing speed extensions. This pattern is local policy, not backend eligibility or price verification; no automatic retry/fallback for backend denial. Full contract: `modules/gpt-speed/README.md`.

## JSON Schema delivery

Opt-in entry `modules/json-schema/src/index.ts`; CLI-only flags, no global settings/auth changes. `--json-schema` must be a JSON object schema with `type: "object"` and activates the feature. `--json-output <path>` selects file delivery; without it the result goes to stdout. Relative paths resolve from the working directory and missing parent directories are created. File output is a same-directory temporary file plus atomic rename; a failed run keeps the previous file, but always check the exit status.

stdout delivery supports print mode with exactly one ordinary prompt: one compact UTF-8 JSON line after the run, diagnostics on stderr (prefix `pi-json-schema:`), nonzero exit on failure. TUI/RPC/`--mode json` are rejected before any model request. Assistant text blocks of final messages are removed in this automation mode so stdout carries only the result. Separate stdout from stderr and inspect the exit code before parsing.

Fallback is always best-effort: parse the last assistant message's JSON and validate; otherwise one extra model extraction request (60 seconds, no retries) using the model that actually answered. A disabled `json_output` tool blocks the extraction request, not validation of direct text JSON. Invalid results, no result, error/aborted runs, SIGTERM and conflicting repeated results fail without delivering anything. The extension never calls `process.exit()`. Extraction usage is not added to session totals. Supported schema scope and caveats: `modules/json-schema/README.md`.

## PTY targets

入口 `modules/pty-terminal/src/index.ts`。`pty_spawn.target` 預設 `local`，WSL／SSH target 讀取 Pi 的有效 `pi-pty-terminal.targets` settings；專案覆寫受 host trust 控制，修改設定後 `/reload`。不直接讀取或寫入真實 SSH/auth/settings。

```json
{
  "pi-pty-terminal": {
    "targets": {
      "linux": { "transport": "wsl", "distribution": "Ubuntu", "cwd": "/home/user/projects/pi-better-tools" },
      "macos": { "transport": "ssh", "host": "mac-dev", "cwd": "/Users/user/projects/pi-better-tools" }
    }
  }
}
```

`local` 為內建保留值。遠端 cwd 必須是絕對 POSIX 路徑；工具 cwd 覆寫設定 cwd，env 只轉送明確指定的值。WSL 僅 Windows，SSH 使用既有 host alias／key／agent、`BatchMode=yes`、15s ConnectTimeout，保留 host-key policy；先由使用者確認 known_hosts。需要遠端 POSIX login shell、sh、env；host/target 欄位不接受自由 options 或密碼。未配置 target／錯誤設定 fail closed，不退回 local。

`npm ci --ignore-scripts` 後執行 `npm run pty:install`，只 rebuild node-pty 原生依賴，無 prebuild 時需編譯工具。根與隔離 production manifest 的 npm 12 allowScripts 僅核可固定 node-pty@1.2.0-beta.14；npm-run adapter 僅移除 inherited allow-scripts env key，以 active npm CLI／Node subprocess 執行，不修改全域 npm 設定或核可任意 scripts。一般 consumer parent project 仍須自行核可 native setup。PTY spawn 不證明連線成功；用 read/wait_exit 檢查輸出與 transport 結束碼。sessionId 綁定 target，其他 file/shell 工具仍是本機。session shutdown 清理 transport（Windows 無 signal，POSIX SIGHUP），不保證遠端背景程序停止。無自動 Git 同步；完整契約及 buffer 限制見 `modules/pty-terminal/README.md`。

## Persistent state

Every new Subagent task automatically persists under `<agentDir>/subagent-sessions/<ULID>/` (manifest, native `pi/`, readable transcript and `runs/`). The `resumable` tool parameter and non-persistent dispatch mode were removed; only verified ready sessions can resume. Old `sub-sessions/v2` logs are preserved as historical data, not migrated into native sessions. Subagent logs/native sessions use Pi's agentDir. Scheduler uses `PI_AGENT_DIR` when set, otherwise `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`; state remains under `pi-scheduler/`. Set both overrides consistently for legacy isolated hosts. Its debug logs intentionally still use the fixed home path.

Do not modify existing registry/native sessions during installation. Back up state before manual repair. Moving bundled agent source paths may make prior managed sessions non-resumable; do not bypass fingerprint/trust checks.
