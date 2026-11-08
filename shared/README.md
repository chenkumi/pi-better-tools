# shared

Pure library code used by several modules under `modules/`. It is not a Pi extension: it has no entry in the
`pi.extensions` manifest and registers nothing by itself.

## Rules

- **No registration on import.** Importing any `shared/src/<area>/index.ts` must not call `registerTool`,
  `registerCommand`, `on` or any other host API, and must not have other side effects. Helpers that take `pi`
  (for example a settings-panel registration function) may live here, but only run when a module calls them
  from its own entry. `tests/no-import-side-effects.test.ts` enforces that importing an area needs no host and adds no globals.
- **One-way dependency.** `modules/*` may import `shared/`; `shared/` must not import `modules/` or any other
  project directory (`tests/unit/module-import-boundary.test.mjs`).
- **Public surface.** Only `shared/src/<area>/index.ts` is public. Modules never import files inside an area.
- **Shipped.** `shared/src` and this file are in the package `files`; `shared/tests` is not.
- No separate license: the root `LICENSE` applies.

## Areas

| Area | Content | Phase |
|---|---|---|
| `contracts/` | Tool-name constants and cross-module result shapes | P3 |
| `prompt/` | Forced/custom system-prompt appender | P1 |
| `background/` | Background job panel, job view, live transcript, Monitor capability | P5 |
| `tool-error/` | `ToolError`: agent-facing failure whose message starts with a stable `CODE: ` (only `content` and `isError` reach the model, not `details`) | — |
| `git/` | `runGit`: read-only git runner (no optional locks, no fsmonitor, bounded time and output; `undefined` on any failure) | — |
| `tool-result/` | `jsonResult`: a result whose text, `details` and `structuredContent` are one JSON-clean value | — |
| `bottom-panel/` | `openBottomPanel`：在輸入框上方（`setWidget` aboveEditor）顯示面板並以 `onTerminalInput` 接管鍵盤，編輯器與 footer 保持可見；全域同時只開一個（`closeBottomPanel` 在 `session_shutdown` 由 Pi Custom Panel 呼叫，避免 reload 後卡住）。面板外框只有主題 `accent` 色的標題線（沒有下方分隔線）。`bottomConfirm`／`bottomSelect`／`bottomInput`：Yes/No、單選與單行文字提問框（訊息過高可捲動，支援 AbortSignal；非 TUI 或已有面板時退回宿主 `ui.confirm`／`ui.select`）。滑鼠與焦點事件不被攔截；fullscreen 下 PgUp／PgDn 仍由宿主捲動聊天視窗，面板內請用方向鍵 | — |
| `settings-panel/` | `/settings:<id>` panel library (shown through `bottom-panel/`, no floating overlay). A validation message the user should see must be thrown as `SettingsInputError`; any other `Error` shows the generic "could not be validated" text | P5b |

Checks: `npm run test:module -- shared` (typecheck + unit tests).

## Tool error codes

Tool failures that the agent can act on start with `CODE: ` (see `tool-error/`); only message text reaches the model. Prefix a module's codes with its name. Codes in use besides the ones owned by older modules (`FORK_*`, `NOTE_*`, `BACKGROUND_*`, `OUTPUT_TOO_LARGE`, file-tools `FILE_TOOL_ERROR_CODE_LIST`, sql-connector `SqlConnectorError`):

| Module | Codes |
|---|---|
| pty-terminal | `PTY_SESSION_NOT_FOUND`, `PTY_SESSION_EXITED`, `PTY_SESSION_LIMIT`, `PTY_SHUTTING_DOWN`, `PTY_SPAWN_FAILED`, `PTY_INVALID_ARGUMENT`, `PTY_SHELL_DISABLED` |
| shell-tools | `SHELL_CAPACITY`, `SHELL_SHUTTING_DOWN`, `SHELL_OWNER_MISMATCH`, `SHELL_BACKGROUND_START_FAILED`, `SHELL_JOB_NOT_FOUND`, `SHELL_JOB_EVICTED`, `SHELL_INVALID_ARGUMENT`, `SHELL_FOREGROUND_ONLY` |
| sqlite-tools | `SQLITE_INVALID_BINDINGS`, `SQLITE_NOT_READY` |
| monitor | `MONITOR_TOOL_DISABLED`, `MONITOR_SHELL_DISABLED`, `MONITOR_OWNER_MISMATCH` |
| remote | `REMOTE_NOT_ENABLED` |
| subagents | `SUBAGENT_CAPACITY`, `SUBAGENT_PROJECT_AGENT_REFUSED`, `INVALID_DISPATCH` (also in `details.errorCode`) |

## Tool results and codemode

A Pi codemode script gets a tool's `structuredContent` when the tool declares an `outputSchema`, and only the text `content` otherwise. Every tool of this package that returns data therefore declares an `outputSchema` and sets `structuredContent` (the same bounded, masked data the text carries) on every successful return path; thrown errors carry no structured value and start with a `CODE: ` (see above). `content` text and `details` stay as they are, because the model reads the text. The host does not validate `structuredContent` against the schema; each module's tests check it with `Value.Check`. Results that cannot be bounded (pager-style text, page bodies) keep their own limits.
