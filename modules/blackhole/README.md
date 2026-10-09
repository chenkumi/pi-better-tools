# pi-blackhole

## Pi Better Tools 本地整合

### 本地現行模式：Pi-only trigger ownership

本整合只在公開 `session_before_compact` 替換摘要，**Pi 控制啟動時點、threshold／reserve、manual／overflow、cut、persist／rebuild、retry／cancel**；允許 Pi 在 final 後進行原生 threshold 壓縮及原生 callback replay。不安裝 private inline adapter，不註冊 Blackhole `agent_end`／`turn_end` threshold 排程或 idle polling，也不包裝 `prepareRequest`／provider stream。

現有 module defaults `compaction: "auto"` + `compactionEngine: "blackhole"` 已走此唯一模式，沒有未啟用的新 timing key。`auto` 現在表示 Pi 啟動時由 BH 提供 summary；`manual`／`off`／`pi-default` 保留 summary 參與的讀取相容，**不能關閉 Pi auto**。明確 `/blackhole` 是 public native request alias，仍使用 Pi 的 authoritative preparation；pending OM 僅在 Pi 已提供 preparation 後 append ledger，**admission 不是 commit**；batch／cursor 保留到 `session_compact` 證明同 session／branch 與 unchanged snapshot 已持久化，重試依已存 batch 去重。peer cancel／abort／persist failure 不清 buffer，unlink 失敗不宣稱 cleanup 完成；原生 pre-hook refusal 不消耗 buffer。

摘要只取 `messagesToSummarize` + `turnPrefixMessages`／`previousSummary`，保持原生 `firstKeptEntryId`／`tokensBefore`，不重新選 aggressive/minimal cut、不還原 context-edit omitted raw messages。Legacy BH threshold／mid-run／tail／retained-output knobs 可讀但不控制 timing 或 retained context，載入明確設定時會提醒；原有 global `compactAfterTokens`（包含被 parser 移除的 81000 residue）不再是啟動條件。Pi 原生 budgets 用當次 `preparation.settings`，不猜固定百分比。詳見 `docs/CONFIG.md`。

有效設定為 unified global／project → PASSIVE defaults（一次）→ explicit env → session override → 純 validation。公開 session_start／reload／session_tree 依當前 host identity／ancestry 恢復 session override；settings overlay 與取消 modal 不重套 PASSIVE。明確 legacy timing/cut 設定在 direct-session 與 modal 路徑都有診斷，512-key bounded in-process 去重跨 reload，不改寫 config。任何 override 都不能重新啟用已移除的 BH 自行 trigger。父於 review 後才建立 project adoption；此模組工作不修改 repository `.pi`、個人設定或 root provenance。以下上游 README 的 auto-trigger／inline／minimal 描述保留作歷史，不是本地現行契約。

Pi-owned review 安全修正：null-edited 通知保留 state-only 邊界骨架，因 Pi 的 invisible-backtrack cut 可能指到它；eligible edits 與 compaction-aware host window 一致。已知原生 cut 界定 evidence，unknown／duplicate 非空 cut 僅出有界 incomplete 診斷，不 include-all、不虛造 ref／coverage。通知 replacement 不沿用 raw producer details 的舊權威。Display copy 同時遵守 native kept IDs、operation 前與目前 eligible edits；null/recovery omission 不重顯示，replacement 僅複製 effective text，raw history 不變，copy 不入 model context。

生成 OM／recall footer 只能依 `blackhole.generatedSpans`（實際 composition offsets、span SHA-256、完整 summary sourceGeneration）剝除；quoted headers/footer、fresh transcript 與無證明 native／legacy text 保留。Memory-on 只依明確 active sourced edits 失效 stale observations 與 supporting reflections；historical source 不在本次 window 不等於 redaction，正常 memory/source IDs 保留。已證明 invalidation 隨 checkpoint carry-forward；native empty-summary fallback 用成功持久化後的 state-only、checkpoint/hash-bound marker 保留 invalidation（不是 model message）。這不會全面清除既有 unproved previousSummary／append segments 的 transitive 污點或 raw history；無來源 proof 的 selective erase 仍 blocked，詳見 `docs/CONFIG.md`。

本目錄是上游 **0.5.12 / a2e4c13** 的來源快照，保留原 MIT LICENSE。實際入口為 `src/index.ts`，轉接原 `index.ts` factory；不載入 npm Blackhole，也不需要 dist。原文的安裝／pnpm scripts／開發 Pi 1.1.0 宣告是上游歷史資訊，**本整合只以根 manifest 的 Pi 1.1.0 為基準**。只在 repository root 管理依賴與唯一 lockfile，不在本目錄 npm/pnpm install。

本地修正：`src/hooks/cosmetic-output.ts` 按 Pi `getBranch()` oldest-first 順序從 compaction 往回找最新被省略的回答，搭配真實順序的回歸測試。`showPreCompactionMessage: true` 時保存有界、清除 terminal controls 的 display-only 副本；保留 16 KiB 上限、去重、retained/aborted 過濾。不修改壓縮時機、tail 行為、模型 context、個人設定或歷史 session；不回填舊缺失副本。

工作包 A 本地適配：`src/core/notification-evidence.ts` 對實際 Pi 1.1.0 persisted `custom_message` 做明確 allowlist 投影，保留 Shell 完成批次、Subagent task/query 結果、Runtime 診斷、Schedule subagent 結果及背景恢復診斷。一般 `recall`／`/blackhole-recall` 可搜尋 ID，並用 `e:<entry-id>`／`page` 展開有界證據；舊 `#N` 仍只計 `message`，不改 schema／設定／舊 ref。摘要只保留已驗證結構資料，不讓通知輸出參與 goal/preference 擷取；排除 display-only 黑洞副本、排程 start marker、private query 欄位及 credentials。保留原始 history，無回填／工作重播／log 讀取；詳見 `docs/recall.md` 的界限。離線真實 host 回歸位於 `tests/integration/notification-evidence.test.ts`，由現有 Blackhole Vitest glob discover。

工作包 A 審查修正：正文僅補 scalar display，權威 structural 直接取 producer-specific details；opaque pending IDs（含 `|`）與 persisted entry ref 分開，有界過濾／裁切標 partial；恢復 task.state／outcome 僅在合法 finding 關係下保留。新 compaction details 可附加窄 `blackhole.notificationEvidence` span/hash/refs provenance，沒有可驗證 metadata 的 legacy Markdown 不剝除、不回填。Evidence 獨立 bounded-line scanner，不改 legacy raw scanner；malformed／各 budget limit 分開報 incomplete。e: 分頁不足時不交付、不推 cursor，0 維持 unbounded selected data；default／append 兩種離線 host probe 都覆蓋 successive compact/resume，詳見 `docs/recall.md`。

工作包 A 窄警告修正：query 根層及 nested queries 的 boolean lateUsage／snapshotUnavailable 從 details 保留，不讓正文覆寫或復活 failed status；e: 未命中同樣遵守文字 budget，另回 selected-inspection 的結構診斷，不推全歷史不存在／不交付 body或cursor。Scanner 增補 finally-close／精確 line／跨 chunk CRLF／EOF 單元測試，未修改其來源；無新增設定或大重構。

工作包 B1 本地適配：`src/core/file-results.ts` 以唯一、同名、時間順序有效的 toolCallId 配對實際成功結果。Note 不需要 input path，只從成功 details.relativePath 取得安全相對路徑，建立活動、內容搜尋與 `#N:path` 使用已儲存 arguments；不讀取現存 note 文件。read 採實際返回 path，write 採 created，edit 採 changedCount；未執行／missing／取消／isError 不列成功活動，exact-path（note 則 exact-payload）重試與歷史 error 分開。原 10,240 字元 extraction/search、50 KiB display 與 recall response cap 不提高；UTF8 note display 不拆多位元字元。Modern version-token 標記的字面檔名不剝除 `:10-40`／`#L12`；不是新的 filesystem canonicalization。Windows 8.3 cwd/Git-root alias 已用真實 Git → extract → compile 重現，仍 blocked 等待有界 metadata identity 決策；不猜 ~1、不任意 probe cwd 外或 following symlink。詳見 `docs/recall.md`；離線實際 producer/native host 回歸為 `tests/integration/note-file.test.ts`。

B1 審查修正：raw collector 以 originating File-call IDs 選擇 authority，duplicate 被 shared pairs 排除後仍拒絕 legacy fallback；不把 File arguments 存入 speculative legacy actions。需 unique／同名／先 call 後 result／explicit false，並確認這一筆 raw result 的位置。R1 的 raw／normalized／compact／touched negative matrix 與 native compact/resume 有回歸；W1 另直接測 head/tail pathTokens 及 non-File consumer，保留 correlated File cases，不恢復不安全 prose retry。非 File legacy parser及 Windows alias 能力不擴包。

根驗證：`npm run test:module -- blackhole`（保留來源 Vitest runner，並有隔離 Pi 1.1.0 native compact/persist/resume/renderer probe）、`npm run test:cross` 和 `npm run test:package`。完整 suite 有環境／上游阻礙時必須回報失敗，不跳過、不當作通過；進度與證據見 repository `plan/`。來源與適配雜湊見 `docs/sources.json` / `docs/adaptations.json`。

本地測試適配：根 `scripts/blackhole-tests.mjs` 保留隔離 HOME／空 credentials／`PI_BLACKHOLE_PASSIVE=true`，但不將 agentDir 環境覆寫蓋過各案例的 SDK mock。`tests/unit-isolation.setup.ts` 僅允許六個明確列出的純 config／mock command 測試暫時移除 passive 覆寫，其他案例維持 passive，並在每案例前後還原。Vitest `.js` alias 限相對來源 import，不改寫宿主 file URL；Windows fixtures 使用 `tmpdir()`／`dirname()`／正規化 Git map keys；唯讀故障注入 EROFS，不依賴 chmod 或 skip；worker deadline 測試以實際 invocation event barrier 對齊 fake clock，不加長 deadline。根 TypeScript compiler 透過 Node resolution 定位，不要求模組內 node_modules。

---

以下為保留的上游 README：

**Deterministic compaction + session-aware observational memory for [Pi](https://github.com/earendil-works/pi) — in one unified extension.**

`/blackhole` replaces Pi's LLM-based `/compact` with an algorithmic structural summary — fast, and the compaction step itself is zero-cost. Three background workers (Observer, Reflector, Dropper) run as separate billed model calls to capture durable facts and decisions that survive across compactions. Per-worker model fallback chains with persisted cooldowns. Manual flush mode. One JSON file to configure it all.

> **A note from the maintainer: this is experimental.**
>
> It won't save you tokens by itself. Compacting is free — no model call, just structure. Remembering is not: the background workers wake up as your session grows, read what happened, and write down what seems worth keeping. Those are real billed calls. Untuned, on your main coding model, this costs more than doing nothing. It only earns its keep with the workers on something cheap or free.
>
> It also doesn't solve compaction — nobody has, as far as I know. It takes a different approach ([observational memory](https://mastra.ai/blog/observational-memory), via [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)) and merges it with [pi-vcc](https://github.com/sting8k/pi-vcc), because the two conflicted when installed together. I merged them and vibeslopped a lot on top: robustness work, new behavior, and bugfixes ported from both upstreams. The recap is pattern-matching, not understanding: it guesses at goals and preferences from their shape. The memory is model-written, so it has the opposite weakness: it can keep what sounds right but isn't. Assume both need the search tool as a backstop.
>
> Want only one half? Use the project that does just that half. No hard feelings.
>
> Scope stays tight on purpose: forks welcome, bug fixes welcome and reviewed, new features only if they serve conversation compaction itself — not the week's AI fad bolted on. Almost everything is a toggle, which I'll admit is tiring; I use a small slice myself. Memory on most days, off some days. Workers on free models, waking rarely, size-based auto-compaction as a backstop. Most days I don't compact at all — fresh sessions beat resumed ones.
>
> Best fit is someone who doesn't count every token: code locally and push the workers to free hosted models, or code on a top model and run the workers on a local card — knowing each worker's different instructions wipe the local prompt cache for the next one. No measurements, no comparisons against other methods. Fast and nearly free the way I run it, good enough for what I need.

---

## Install

```bash
# From npm (recommended)
pi install npm:pi-blackhole

# Or directly from GitHub.
# Requires npmCommand to be set in settings.json, otherwise pi runs
# `npm install --omit=dev`, devDependencies are skipped, and dist/ is not built.
# Example: "npmCommand": ["npm"] in ~/.pi/agent/settings.json
pi install git:github.com/k0valik/pi-blackhole
```

If you have standalone `pi-vcc` or `pi-observational-memory` installed, remove them first — they conflict and will prevent blackhole from loading:

```bash
pi uninstall npm / git:https://github.com/sting8k/pi-vcc
pi uninstall npm / git:https://github.com/elpapi42/pi-observational-memory
```

Then `/reload` or restart Pi. The config file at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json` is created with sensible defaults — no setup required for the default behavior. Config merges global → project → env → session (session is ephemeral). See **[`docs/CONFIG.md`](docs/CONFIG.md)** for tuning or run `/blackhole settings` to open the interactive overlay.

> **Want a guided setup?** Pass [`llms.txt`](llms.txt) to your agent — it will walk you through the interview, including picking cheap fallback models for your providers.

---

## ✨ What's new

> **Latest release: [0.5.12](CHANGELOG.md)**
>
> - **Pi 1.x is supported** — the declared peer range widens to `<2.0.0`, so Pi 1.0/1.1 installs no longer report an out-of-range peer.
> - **Mid-run inline compaction keeps the turn open for RPC/SDK clients** — the compaction event no longer advertises itself as a user-initiated `/compact`, so `pi --mode rpc` frontends stop ending the run mid-turn ([#150](https://github.com/k0valik/pi-blackhole/issues/150)).
> - **Toolchain refresh** — pnpm 12.10.0 and the dev-dependency group are current; runtime behavior is unchanged.
>
> See [`CHANGELOG.md`](CHANGELOG.md) for the full history.

---

## What it does

Long engineering sessions degrade. Pi's native `/compact` calls an LLM to write a free-form prose summary — then compacts that summary, then compacts the next. After a few cycles, load-bearing details vanish: why a decision was made, which approaches were rejected, what the user clarified early on. The session is still alive; the agent has stopped carrying the real context.

`pi-blackhole` solves this in two complementary ways:

- **Algorithmic compaction** — a deterministic, zero-cost `compile()` pipeline extracts structured sections (goal, files, commits, preferences, brief transcript) and replaces the old conversation with one compact block. No LLM is called for compaction itself.
- **Observational memory** — three background workers (Observer → Reflector → Dropper) run during the session, capturing timestamped facts and distilling durable reflections in a session ledger that survives every compaction.

Both halves share a single hook and a single output. Together they keep the agent's context sharp across arbitrarily long sessions — without the cost, drift, or erosion of repeated LLM-based summarization.

---

## Commands

| Command                     | Description & Options                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/blackhole`                | Manual compact — deterministic structural summary                                                                                                       |
| `/blackhole settings`       | Open the configuration overlay _(Alias: `/blackhole configure`)_                                                                                        |
| `/blackhole changelog`      | Open the in-app changelog viewer                                                                                                                        |
| `/blackhole cleanup`        | Remove orphaned pending files                                                                                                                           |
| `/blackhole om-off`         | Disable observational memory                                                                                                                            |
| `/blackhole om-on`          | Enable observational memory                                                                                                                             |
| `/blackhole-memory`         | Memory pipeline status & token counters _(Same as `/blackhole-memory status`)_                                                                          |
| `/blackhole-memory view`    | Show visible observations and reflections (after compaction trimming), copied to clipboard                                                              |
| `/blackhole-memory full`    | Show **all** recorded memory (including dropped observations), copied to clipboard                                                                      |
| `/blackhole-recall <query>` | Search session history. Supports `page:N`, `scope:all`, `mode:file                                                                                      | touched`, regex *(Also available to agent as `recall` tool)* |
| `/blackhole-export`         | Export distilled project memory (observations/reflections across past sessions + pending buffers) to import-ready markdown _(Options: `out:<path>.md`)_ |

All commands work regardless of `compaction` mode — only _when_ auto-compaction fires changes. See [Compaction modes](#compaction-modes) below.

<details>
<summary>The `recall` tool (agent-facing)</summary>

The agent gets one unified `recall` tool that handles every form of historical lookup. Searches read the raw session file directly, bypassing compaction.

| Input           | What it does                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[12-char hex]` | Recover source evidence for a specific observation or reflection ID from the session ledger.                                                                                         |
| `#N`            | Expand a session entry by index (show full content, bounded by the response budget).                                                                                                 |
| `#N:path`       | Drill-down into file content from a tool call (e.g. `#42:auth.ts` shows first 30 lines; `#42:auth.ts:30` shows the next 30; `#42:auth.ts:full` shows everything).                    |
| `#N:text`       | Drill-down into a message body (user/assistant/tool/bash text) with the same paging (`#42:text`, `#42:text:30`, `#42:text:full`) — the continuation path for budget-clipped entries. |
| Free text       | BM25-ranked search across transcript and/or file content. Rare terms weighted higher.                                                                                                |
| `mode:file`     | Search only write/edit file content.                                                                                                                                                 |
| `mode:touched`  | Aggregate all files written/edited across the session, grouped by path.                                                                                                              |
| Regex           | Pattern search (e.g. `fork.*pi-vcc`, `hook\|inject`).                                                                                                                                |
| `scope:all`     | Search across all session lineages (default: active lineage only).                                                                                                                   |

When the agent expands a session entry (`#N`), related observations and reflections from the session ledger are automatically shown alongside the expanded content — so the agent gets the raw transcript _and_ the durable fact layer in one call.

Every recall response is capped at `recallResponseMaxChars` (default 48,000 ≈ 12k tokens). Search snippet lines, expanded entries, drill-down bodies, and related observation bodies are clipped to keep a single huge stored message from flooding the context; a truncation marker names the omitted entries and how to continue (`#N:text` / `#N:path` / `page:N`). A capped drill-down cuts only at line boundaries and names the first line it did not show, so the next `#N:path:offset:limit` call continues there without skipping or repeating lines.

The `/blackhole-recall` command exposes the same engine to the user. Results are shown as a collapsible message and auto-fed to the agent as context.

</details>

---

## Compaction modes

Two modes, one shared goal: keep your agent's context sharp without manual housekeeping. (`compaction: "off"` is a third escape hatch that hands everything back to Pi.)

|                             | Auto (default)                                                         | Manual (`compaction: "manual"`)                  | Off (`compaction: "off"`)                                  |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Workers run?                | Yes                                                                    | Yes                                              | Yes (unless `memory: false`)                               |
| Observations go to          | Conversation markers (invisible in TUI)                                | Per-session disk buffers                         | Conversation markers                                       |
| Auto-compact on `agent_end` | Yes — fires at the auto-compaction threshold (preset curve by default) | No                                               | No (Pi handles it)                                         |
| `/compact` (Pi built-in)    | Replaced by blackhole                                                  | Pi handles                                       | Pi handles                                                 |
| `/blackhole`                | Optional                                                               | **Required** to flush + compact                  | Optional, but works                                        |
| Use case                    | "Install and forget"                                                   | "I want to control when context gets compressed" | "Let Pi handle it, but I want `/blackhole` when I need it" |

Manual mode is the maintainer's daily driver: workers still run, but observations accumulate in `<sessionId>-pending.json` files instead of cluttering the conversation. `/blackhole` flushes the buffer, runs algorithmic compaction, and injects durable reflections in one shot.

`compaction: "off"` + `memory: false` (or `PI_BLACKHOLE_PASSIVE=true`) completely disables all background workers and blackhole's auto-compaction — useful for debugging or comparing against Pi's native path. Explicit `/blackhole` still works in this mode.

#### Who owns the compaction?

With the default `compactionEngine: "blackhole"`, blackhole's `session_before_compact` hook owns every compaction Pi initiates — threshold auto-compact, overflow recovery, and `/compact` — replacing Pi's LLM summarizer with the deterministic pipeline. The only exception is defensive: if both the VCC summary and the OM projection come up empty (a pathological all-noise transcript), blackhole declines and Pi's native summarizer runs, so you never get a context-free replacement. With `compactionEngine: "pi-default"`, `compaction: "manual"`, or `compaction: "off"`, Pi handles everything except explicit `/blackhole`. See [`docs/CONFIG.md` → `compactionEngine`](docs/CONFIG.md#compactionengine) for the full interaction matrix.

### How does `/blackhole` compare to `/compact`?

- `/compact` calls an LLM to write a free-form summary — costly, lossy, no memory layer.
- `/blackhole` uses algorithmic section extraction (goals, files, commits, preferences…) **plus** injects observations and reflections from the session ledger. No LLM is involved in the compaction itself. Fast, deterministic, memory-preserving - the observational memory pipeline's arrived results apply instantly on compaction.

`/blackhole` is essentially a single `/compact` that just works — especially in manual mode.

---

## How it works

When `/blackhole` fires (manually or via the auto-trigger), two things happen in one shot:

1. **The vcc pipeline** analyzes the transcript tail and produces a structured summary: session goal, file changes, commits, outstanding blockers, user preferences, and a rolling brief transcript. Deterministic — same input always produces the same output.
2. **Observational memory injection** renders accumulated observations and reflections from the session ledger and appends them below the summary.

The agent receives a deterministic recap of recent work _plus_ durable facts from the full session history — in a single replacement block. No LLM was called for the compaction itself.

---

## Quick start config

Defaults target ~128k context models and work out of the box — no tuning required. To keep costs low, set cheap models for the background workers (the only required change for most setups):

```json
{
  "observerModel": { "provider": "openrouter", "id": "qwen/qwen3-next-80b-a3b-instruct:free" },
  "reflectorModel": { "provider": "cerebras", "id": "gpt-oss-120b" },
  "dropperModel": { "provider": "cerebras", "id": "gpt-oss-120b" }
}
```

Fallbacks (optional): each worker tries `stageModel → stageFallbacks → base model → session model` (skipping cooled-down models). By default the session model **is** the last-resort fallback (`sessionFallback: true`), so workers keep running even with no worker models configured. If you don't want worker runs to touch your session model (extra cost and prompt-cache busting), configure cheap worker models (above) and set `sessionFallback: false` — or set `model` as a shared fallback so the session model is never reached. See [`docs/CONFIG.md` → Model Configuration](docs/CONFIG.md#model-configuration).

Config file: **`~/.pi/agent/pi-blackhole/pi-blackhole-config.json`**

Full reference — every key, default, and env override — lives in:

- 📘 **[`docs/CONFIG.md`](docs/CONFIG.md)** — authoritative config reference. Start here for tuning.
- 🤖 **[`llms.txt`](llms.txt)** — agent-facing interview. Pass it to your agent for a guided setup.
- 📦 **[`example-config.json`](example-config.json)** — annotated example with fallback rationale and `thinking` levels.

---

## Demo

`/blackhole` collapses ~143k tokens of conversation into a ~6.3k structured summary (YMMV based on your settings). `/blackhole-memory` shows pipeline status. `/blackhole-recall` searches history — the agent can do the same via its `recall` tool.

https://github.com/user-attachments/assets/a7dd804d-6aca-4bdb-8b6e-0dd779363a43

### The three memory workers

Three background workers (separate LLM calls) run automatically during the session when `memory: true` (the default):

- **Observer** — reads conversation since the last observation marker and extracts timestamped facts: events, decisions, preferences. Input is capped to `observerChunkMaxTokens` as an oldest-first prefix (overflow drains in bounded follow-up batches) to prevent context blowup on long sessions — the coverage cursor never advances past entries the model was not shown. Runs most frequently.
- **Reflector** — distills new observations into durable reflections: stable facts, patterns, and constraints that survive future compactions. Runs less often.
- **Dropper** — prunes low-value observations from active memory when the pool exceeds `observationsPoolMaxTokens`, while keeping reflections and other long-term elements safely in the session ledger.

```
[Conversation turn] ──> (accumulated tokens >= observeAfterTokens)
                            │
                            v
                    1. OBSERVER   (extracts timestamped observations)
                            │
                            v
                    2. REFLECTOR  (synthesizes durable reflections)
                            │
                            v
                    3. DROPPER    (prunes low-value observations)
```

Each worker uses an `agentLoop` with tool-calling capabilities — they don't just make a single LLM call. The observer, for example, can call `record_observations` multiple times per run to work through a chunk incrementally.

If any stage fails (model error, rate limit, timeout), remaining stages are skipped and the full pipeline retries on the next `agent_start` or `turn_end`. A 30-second retry gate prevents hammering failing APIs. Within each stage, the runtime tries all configured fallback models before giving up — each failed model is cooled down and skipped in subsequent attempts.

---

<details>
<summary>What the agent sees after compaction</summary>

After compaction, the agent sees something like this (sections appear only when relevant — a session with no git commits won't show `[Commits]`):

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug...

[assistant]
Root cause is a missing token refresh...
...transcript continues...

---
The conversation before this point has been compacted into the summary above.
Details not captured here — exact code, error messages, file paths — are only recoverable via `recall`.
Use `recall` to search the session history. Do not redo work already completed.

## Reflections
[c3d4e5f6a1b2] User is building Acme Dashboard on Next.js 15 with Supabase auth.

## Observations
[a1b2c3d4e5f6] 2026-05-23 [high] User decided to switch from REST to GraphQL; motivation was reducing over-fetching.
[b2c3d4e5f6a1] 2026-05-23 [medium] GraphQL migration completed; user confirmed working.

----
Bracketed ids in reflections and observations connect to their source session entries.
These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use `recall` with an id to retrieve original context.
----
```

> **Note:** The OM injection format uses `## Reflections` and `## Observations` Markdown headers followed by a brief footer. Each observation and reflection has a 12-char hex identifier the agent (and you, via `/blackhole-recall`) can use to recover source evidence. When no observations or reflections exist, only the short recall-guidance footer is appended.

</details>

---

<details>
<summary>Feature comparison</summary>

|                                             | pi-blackhole | pi-vcc | pi-obs-memory | Pi default |
| ------------------------------------------- | ------------ | ------ | ------------- | ---------- |
| Algorithmic compaction (no LLM cost)        | ✓            | ✓      | —             | —          |
| Deterministic output                        | ✓            | ✓      | —             | —          |
| Structured summary sections                 | ✓            | ✓      | —             | —          |
| Observations + reflections                  | ✓            | —      | ✓             | —          |
| Context survives across compactions         | ✓            | —      | ✓             | —          |
| Background memory workers                   | ✓            | —      | ✓             | —          |
| Searchable history after compaction         | ✓            | ✓      | partial       | —          |
| Per-worker model config                     | ✓            | —      | —             | —          |
| Fallback model chains + persisted cooldowns | ✓            | —      | —             | —          |
| Manual flush mode (`compaction: "manual"`)  | ✓            | —      | —             | —          |
| Memory toggle (`/blackhole om-off`)         | ✓            | —      | —             | —          |
| Unified single-file config                  | ✓            | —      | —             | —          |
| Per-session pending state                   | ✓            | —      | —             | —          |

</details>

---

## Uninstall

```bash
pi uninstall git:github.com/k0valik/pi-blackhole
rm -rf ~/.pi/agent/pi-blackhole
```

---

## Documentation map

| Doc                                                          | Audience          | What's in it                                                                              |
| ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------- |
| **[`README.md`](README.md)**                                 | You, now          | Install, commands, the pitch, the value, the demo.                                        |
| **[`CHANGELOG.md`](CHANGELOG.md)**                           | You               | Every release, what changed, who contributed.                                             |
| **[`CONTRIBUTING.md`](CONTRIBUTING.md)**                     | You, if helping   | Branch model, dev setup, PR description format, docs/changelog gates.                     |
| **[`docs/CONFIG.md`](docs/CONFIG.md)**                       | You, when tuning  | Every config key with type, default, behavior, and env-var overrides.                     |
| **[`llms.txt`](llms.txt)**                                   | Your agent        | Step-by-step guided setup interview, anti-patterns, exact file paths, internal constants. |
| **[`docs/MIGRATION-GUIDE.md`](docs/MIGRATION-GUIDE.md)**     | You, if upgrading | Old → new config key mapping, semantic changes, automatic migration behavior.             |
| **[`docs/OLD_CONFIG.md`](docs/OLD_CONFIG.md)**               | Reference only    | The legacy pi-vcc / pi-observational-memory config surface. Kept for historical context.  |
| **[`example-config.json`](example-config.json)**             | You               | Annotated example config with comments.                                                   |
| **[`docs/APPEND_COMPACTION.md`](docs/APPEND_COMPACTION.md)** | You, if curious   | Rules for `compactionSummaryMode: "append"`.                                              |

> **Note:** All docs except `README.md`, `CHANGELOG.md` (package root, read by `/blackhole changelog`), and `llms.txt` live under `docs/` — product docs (`architecture.md`, `CONFIG.md`, etc.); `archived_docs/` is local-only (gitignored).

---

## Credits

`pi-blackhole` started as a merge of two upstream projects but has since diverged significantly. The codebase still carries DNA from both:

- **[pi-vcc](https://github.com/sting8k/pi-vcc)** by @sting8k — algorithmic conversation compaction (the `compile()` pipeline, section extraction, recall core).
- **[pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)** by @elpapi42 — session-ledger-based observation/reflection capture, memory agents, ledger folding.

What blackhole adds and reworks on top:

- **Unified configuration** — one JSON file, not two.
- **Per-worker model fallback chains** with persisted cooldowns that survive Pi restarts.
- **Manual flush mode** — `compaction: "manual"` saves observations to per-session disk buffers.
- **Conflict resolution** — OM hooks into vcc's compaction, not Pi's default.
- **Memory toggle** (`/blackhole om-off` / `/blackhole om-on`) — disable the memory layer without uninstalling.
- **Per-session pending state** — isolated per-session JSON files, no cross-session contamination.
- **Custom provider bridge** — consolidation agents loaded via jiti can still use provider stream functions registered by other extensions.
- **Retryable error detection with per-model cooldowns** — models that fail get cooled down, fallbacks tried automatically, 30-second retry gate prevents spam.
- **Improved observer/reflector/dropper prompts** — each heavily customized with detailed extraction rules, relevance guidance, and error handling.
- **OM-recall coupling** — when expanding session entries via `recall`, related observations and reflections are automatically shown.
- **Thinking level support** — per-model `thinking` field for reasoning effort control, including `max` where supported by the provider.

## License

MIT
