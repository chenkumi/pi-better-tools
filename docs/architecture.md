# Architecture

## One deployment unit, nine modules

The root `package.json` declares nine explicit TypeScript `pi.extensions` entries, all at `./modules/<name>/src/index.ts`: six current source snapshots (including PTY Terminal) and three native modules (Note Tools, GPT Speed and the rewritten JSON Schema). Thin default-export entries forward to existing implementations without moving guards, agents, prompts or workers. Web already uses this layout. There is no aggregator factory or plugin-manager abstraction. Pi controls discovery, ordering, resource filters, tool selection and lifecycle dispatch.

- `modules/subagents/extensions/subagent/` retains the `../../agents` relationship and `child-guard.ts`; bundled agents/prompts ship with the package.
- `modules/shell-tools/extensions/timeout-ms.ts` imports its adjacent MJS adapters and preserves host shell definitions.
- `modules/file-tools/extensions/file-tools.ts` imports the file-operation core; the real `src/diff-worker.mjs` ships unbundled.
- `modules/web-tools/src/index.ts` retains direct TS imports, lazy browser service, schemas and configuration example.
- Pi loads `modules/scheduler/src/index.ts` directly, forwarding to `src/extension.ts`. No compiled artifacts are required by the extension. `npm run build` still compiles `src/` to `dist/` for the standalone `pi-scheduler` bin (`dist/runner.js`); both TS sources and compiled CLI dependencies ship in the same root package. Scheduler metadata uses root TypeScript/Vitest, with no independent install or lockfile.
- `modules/note-tools/extensions/note.ts` is a native TypeScript extension, not an imported source snapshot. It registers only `note`, uses invocation `ctx.cwd`, creates category folders and timestamp-named UTF-8 Markdown files with exclusive-create (`wx`), then returns absolute/relative paths. It has no settings or lifecycle resources; subsequent operations use File Tools. Hash provenance is recorded separately in `docs/native-modules.json`.

- `modules/gpt-speed/extensions/gpt-speed.ts` independently registers three speed commands, persists `pi-gpt-speed.mode`, resolves effective service tier from a strict model-ID pattern and displays it via Pi's status API. Its request hook shallow-clones only eligible OpenAI/Codex payloads. Pattern matching and downgrade are pure; selected preference survives model changes. No timers, provider registrations, model calls or source-project dependency. The existing `proper-lockfile` dependency coordinates global settings writes with Pi; synchronous critical sections contain no await. Hash provenance is in `docs/native-modules.json`; pi-codex-fast was a conceptual reference, not an imported source snapshot.

- `modules/json-schema/extensions/json-schema.ts` is a project-native, opt-in structured-output extension (formerly an import of @nqbao/pi-json-schema, since rewritten; see docs/native-modules.json). Flags are `--json-schema` and `--json-output`; zod 4 (`z.fromJSONSchema`) validates after `src/schema.ts` rejects constructs zod cannot enforce faithfully. It registers a model-only terminating `json_output` tool, strips assistant text blocks from finalized messages through the public `message_end` contract, and delivers at `session_shutdown`: a file (atomic temp + rename) or one JSON line written through the stdout stream's own prototype so the host's stdout redirection is not touched. Without a tool call it parses the last assistant text, then makes one bounded extraction request using the model that actually answered (virtual routers cannot be called directly). Existing tool selection stays authoritative; no global settings/auth persistence.

Root dependencies/lockfile are authoritative: the four Pi development packages are fixed at **1.0.0**. Nested manifests preserve source identity/test commands only; do not install their dependencies independently. Host Pi/AI/Agent Core/TUI/TypeBox remain wildcard peers, not runtime dependencies; fixed dev versions are test baselines only.

Runtime dependency refresh: `diff` is pinned to 9.0.0 and `jsdom` to 30.1.1. The root Node.js engine range is `^22.22.2 || ^24.15.0 || >=26.0.0`, matching jsdom 30; older module README engine claims are historical source metadata, not the integrated package requirement. Source snapshots and the Pi 1.0.0 development baseline remain unchanged.

## PTY target routing

`modules/pty-terminal/src/index.ts` retains the seven source tools. Pure `targets.ts` resolves optional target (local default) using effective trust-aware Pi settings; it creates WSL argv or a POSIX-quoted SSH command without spawning resources during factory initialization. `pty-manager.ts` owns local native PTY transports/session metadata and shutdown. All follow-up operations use the original sessionId, not mutable global target state. Remote cwd/env are separate from local client cwd/env; unknown targets fail closed. Windows native cleanup does not pass POSIX signals. A local transport PID/exit does not establish remote process-tree termination. Root node-pty dependency is pinned to the source beta version; native setup is explicit after ignore-scripts. Source hashes and adaptations document the import; no source-path dependency, Git synchronization or remote credential storage.

## Source maintenance

`docs/sources.json` records initial hashes; `docs/adaptations.json` records reviewed local changes and current hashes. Source projects are immutable inputs. A future import must compare source changes and re-run module, integration and package checks; importing a source snapshot does not create automatic synchronization.

Local provenance verification checks every recorded hash strictly, including separately marked historical deltas whose earlier contents are unavailable. It warns rather than claiming original-diff equivalence; `--originals` still checks accessible immutable source bytes. Native stale metadata retains its previous recorded hash and local inspection scope. See `docs/source-references.md` for the audit boundary.

Individual historic matrix/production scripts under modules were retained as source evidence; they may assume an independent package lockfile/layout. Use the root validation scripts for this integrated repository.

## Subagent persistence decision (2026-10-01)

At the user's request, every initial task/step now owns a managed native session; ephemeral dispatch and the `resumable` opt-in parameter were removed. Single/parallel/chain remain dispatch shapes, not persistence modes. Creation and resume share the existing guard, fingerprint, locks and checkpoint transaction. Only ready can resume; errors/cancellation retain evidence without automatic takeover. Existing logs/manifests are not rewritten. This is an explicitly authorized runtime adaptation, recorded in `docs/adaptations.json`, not an unchanged source transplant.

Native digest and readable-log acknowledgement now share one bounded identity map, keeping canonical deduplication independent without retaining the same result key in two sets. Original stream/output/disk policy limits remain unchanged.

## Session-owned background execution (2026-10-05)

Shell `src/background-jobs.ts` and Subagent `extensions/subagent/background.ts` own separate bounded job registries, cancellation controllers and owner/generation fences. `background:true` returns acceptance, not completed tool usage/exit status; synchronous calls stay unchanged. Jobs live only while the original Pi runtime/session is alive. Completion is a model-visible custom `followUp` message with automatic turn triggering, not a privileged system instruction. Exit/reload/replacement cancel and suppress obsolete notifications; SDK callers must await runtime disposal. No daemon, durable restart queue, exactly-once delivery or provider/process-tree termination guarantee is introduced. Async Subagent/query usage is explicitly reported rather than falsely attributed to host totals.

Background Subagents retain the existing child argument builder and guard but use a correlated RPC stdin/stdout transport; synchronous dispatch remains JSON print. Child identity is verified by startup guard plus `get_state`, with canonical input logged consistently for wire/native digest. Completion notification follows transcript finalization, native checkpoint commit, child cleanup and writer release. Recursion exclusion now includes all four Subagent tools. Per-task runtime/status exposes log paths only after allocation; queued/chain tasks do not claim files exist.

Control is literal FIFO delegated user input consumed at safe loop boundaries, with queued versus applied/unknown delivery evidence. Query uses a token-bound IPC bridge to make an isolated in-memory, tool-free request from a canonical safe prefix; it never forks/rewrites the managed native file or invokes mainline hooks. Provider metadata and context edits/compaction are replayed, unsafe snapshots fail closed. Query usage, stale-snapshot metadata, cancellation and leases are independent; abandoned resources retain permits until terminal evidence/actual child close. Query tool-call streaming aborts before dispatch.

No history-reading tool is added. `read` keeps its original target and offers advisory same-directory-final/wait guidance only for missing managed `.partial` log paths. Rename/commit semantics stay unchanged; permission/probe failures never imply completion. Offline actual-host tests verify control/query isolation and automatic parent follow-up after managed commit; they do not certify real-provider behavior or the new capability on older hosts.

## Test boundaries

At the owner's request (2026-10-03), stress-only high-volume payloads, giant-file/repeated diff loads, concurrent log load and thread-pool saturation probes were removed with their unused fixtures. Ordinary functionality, cancellation, resource cleanup and exact safety-limit tests remain; removed coverage is not part of current verification.

Note Tools uses Node/tsx tests for all five categories, exact content, schema, invocation cwd, empty files, collisions, parallel creation, pre-start cancellation and filesystem errors. Root loader and production tarball probes also create notes and read/edit their returned paths with File Tools, and ensure read-only/no-tools/exclusion keep note inactive.

GPT Speed uses Node/tsx tests for version/pattern boundaries, provider gates, command idempotence, downgrade/model transitions, TUI/headless/RPC, global/project precedence and trust, persistence preservation and corrupt/locked settings. Real Pi loader/session and production-tarball fixtures exercise commands and request-hook composition in full/read-only/no-tools/exclude/search/child modes without network calls. TUI status strings are tested at the API boundary, not by a human visual terminal inspection.

The source-only loader regression stages all modules without any `dist/` artifacts and exercises full/child lifecycle smoke via the nine uniform TS entries. Manifest tests compare entries against every module directory and actual loader paths, not only a dynamic count. Missing module metadata/scripts fail before npm can walk up and recursively execute the root runner.

Source tests retain their Node/tsx/Vitest runners. Subagent unit files and File Tools run sequentially (`--test-concurrency=1`) to avoid CPU-count parallel imports/workers distorting real resource deadlines; concurrency inside individual parallel/chain/cleanup tests is unchanged, as are assertions and production budgets. Existing protocol/I/O units use an explicit managed-storage boundary substitute; they do not establish native checkpoint/guard correctness. Separate real store/native fixture tests and offline actual-Pi CLI creation/resume tests cover those contracts. Root integration uses isolated subprocesses because module-level configuration constants and Pi registries are process-local. Real Pi loader/session probes check activation, prompts, file mutations/worker, search mode registration, Scheduler policy and reload/shutdown.

Root typecheck now includes Subagent production TypeScript via its noEmit tsconfig; a typed never-returning function and explicit transcript-content guard enable strict narrowing without changing persistence behavior. Subagent unit-file serialization avoids exhausting the existing 300ms Windows I/O injection setup budget; assertions and production budgets are unchanged.

Fixture cleanup waits for late writer creation, transcript close and abandoned spool iterator completion before removing test artifacts; early startup failure is reported rather than waiting forever for an injection point.

The root tarball smoke accepts strict single-package legacy-array and npm 12 package-keyed manifests, checking identity, resource paths, counts and sizes before a pack stage is marked passed. Module READMEs and existing/authorized license notices are explicitly included rather than relying on npm's nested-document behavior. npm resolution prefers the current Linux/macOS Node installation, retains Windows drive/UNC and case-insensitive Path handling, and avoids inherited WSL Windows npm when native npm exists.

The root tarball smoke installs actual production dependencies with no development-tree junctions. Source File Tools' historical packaged regression still uses a development dependency link; it is not substituted for the production smoke. A test-only fixture is copied outside this repository and imports the explicitly installed host SDK.

No test makes a real paid model call. Offline CLI tests use explicit synthetic providers, not production credentials. Chromium/local fixture tests use a code-only private-network testing seam; that permission is not exposed as user configuration. The large-output/Read test composes real FetchService, toolOutput and Pi-wrapped File Read components; it is not a model-callable private-network bypass or a paid backend end-to-end test.

Pi 1.0.0 回歸另有 `tests/fixtures/sdk-hooks.mjs`：使用九個實際入口、file-backed 隔離 settings 與離線 provider，檢查 defaultTools reload、explicit／no-tools／exclusion、延後註冊工具的 restore／reload／放棄，以及 hidden declaration 的 prompt snippets 和既有 catalog／Web section 合成。真實 read tool pipeline 檢查 hook 次序與 awaited stream delivery；這不是真實 OpenAI backend 或完整 MCP server E2E。三版 production matrix 重跑相同 fixture，舊版以其明確歷史契約驗證。

JSON Schema uses isolated actual-CLI probes with the entire stdout parsed as JSON, synthetic authenticated provider, no fetch and all nine manifest entries. Cases cover tools/text/fallback, missing/invalid flags and schema, numeric overflow, errors/empty/aborts, duplicate/conflicting data, disabled tools, virtual best-effort routing, legacy file delivery and signal-event cancellation. Pure/extension-boundary tests add queue/pre-rename cancellation and activation fencing. Production tarball reruns the CLI suite under each matrix host; this is not paid-backend tool-choice verification. See `plan/JSON-SCHEMA.md` for actual checks and limitations.

## Lifecycle and compatibility limits

0.99.1 → 1.0.0 的已使用 hook declarations、dispatcher 與 Agent Core loop 無契約變更；不因此移除 Scheduler admission fences、boundary composition 或 Web 的 abort-on-conflict。1.0.0 新增 defaultTools reload／pending tool restoration，以及排除 hidden tool snippets 的 host 行為。`defaultTools` 不限制 default-active extension tools；嚴格 allowlist 使用 explicit `tools`／`--tools`。Subagents durable `hostContract: "0.99.1"` 是格式身份，不是目前 SDK 版本。

Resource factories only register behavior. Scheduler starts timers/locks at session_start; Web launches browser lazily; shutdown/reload releases owned resources. Different packages with the same tool names are not deduplicated by package identity, so old standalone extensions must be disabled.

Scheduler children retain `PI_SCHEDULER_CHILD=1`. Ordinary Subagent processes are not newly prohibited from becoming a Scheduler host/standby. Parent-only `-e` paths do not automatically propagate to children. Moving bundled agent files can invalidate saved managed-session fingerprints; no automatic migration is added.
