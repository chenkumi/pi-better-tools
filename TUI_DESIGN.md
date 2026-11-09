# TUI自製計畫

實作位置：主畫面與 Tool Call 在 `modules/pi-custom-panel`；底部面板外殼在 `shared/src/bottom-panel`，Jobs 面板在 `shared/src/background`，Settings 面板在 `shared/src/settings-panel`；排程清單在 `modules/schedule-commands`。畫面中的規則線都是主題的 `accent` 色。

## 主畫面
* 輸入框部分修改

 ```
 ▀▀█  v1.5.0
 █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 Press ctrl+o to show full startup help and loaded resources.

 Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.


[Context]
  ~\.pi\agent\AGENTS.md, AGENTS.md

[Skills]
  agents-md-creator, audit-plan, clean-code-refactor, create-plan, draft-plan, execute-plan,
expert-lens, find-skills, orca-cli, pi-tools-config, playwright-cli, reproduce-bug, research-plan,
review-diff, software-architecture-principles, software-refactory, software-reliability,
software-scan-bugs, test-case-creator, test-suite-tidy, thinking-plan, verify-findings,
write-prompt

[Prompts]
  /implement, /implement-and-review, /scout-and-plan

[Extensions]
  @lordekeen/pi-navigator, fff-override.mjs, file-audit/src, file-tools/src, fork/src,
gpt-speed/src, json-schema/src, monitor/src, note-tools/src, orca-agent-status.ts,
orca-prefill.ts, orca-titlebar-spinner.ts, pi-auto-compact/src, pi-runtime/src, pty-terminal/src,
remote/src, schedule-commands/src, shell-tools/src, skill-tools/src, sql-connector/src,
sqlite-tools/src, subagents/src, theme-tools/src, web-tools/src


 Reloaded keybindings, extensions, skills, prompts, themes, and context files



──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000
```
---

## 背景任務面板
* 輸入框上方的被動面板，只在有進行中的工作時出現（僅 TUI；外框是主題 `accent` 色的標題線，沒有背景方塊，也沒有下方分隔線）
* 計數列固定顯示 Shell／Subagents／Fork／Monitor；PTY 與 Schedule 有工作時才出現
* 每個工作一行，合計最多五行（終端太矮時更少），其餘以 `… N more` 表示；排序為取消中、執行中、收尾中、排隊中
* 列格式：`<狀態圖示> <種類代碼> <名稱> · <標題>` 靠左，狀態與用量靠右。種類代碼 SH／SA／FK／MN／PT／SC；圖示 ● 執行中、◷ 排隊、◐ 收尾或取消中、✓ 完成、○ 其他
* 右欄：Subagent 為 `狀態 | 用量`（`*` 表示累計中的已回報用量）；Shell 執行中只有 `N/A`；Monitor 為 `wake on|off | 剩 <時間>`；Schedule 閒置為 `in 12m | every 1h`、執行中為 `running`
* fullscreen 可點工作列直接開該工作的詳細，點 `[Open]` 開清單；滑鼠停留會高亮，不改變版面

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 ⌘ Shell: 1 · ▷ Subagents: 2 · ⋔ Fork: 0 · ⌖ Monitor: 1 · ⌸ PTY: 1 · ⏱ Schedule: 1
 ● SH npm run build                                                                    N/A
 ● SA scout · find the entry point                                         running | 12.3k*
 ◷ SA reviewer · review the diff                                           queued | pending
 ● MN command · tail -f logs/app.log                                     wake off | 剩 24m
 ● SC nightly-report · agent gpt-5                                      in 12m | every 1h
 … 2 more [Open]  * reported usage
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## Subagent / Fork / Shell / Monitor / PTY / Schedule 展開
* 點工作列或 `[Open]`（或輸入 `/background-jobs`）開啟，顯示在輸入框上方的底部面板，內容最多 8 列，握有鍵盤直到 Esc；編輯器與 footer 保持可見
* 三層：清單 → 詳細 → （批次工作）任務清單。`/background-jobs [more|all|subagents|shell|fork|monitor|pty|schedule|collapse]` 可直接篩選
* 執行中的工作可以看串流內容（記憶體副本，只供顯示，工作結束即釋放）：Subagent／Fork 為子行程的對話，Shell 與排程 shell 為輸出尾端（上限 128 KiB），排程 agent 為子 session 的對話。PTY 的即時內容是終端畫面（固定大小的模擬畫面，取最後 n 列、n 依終端高度，不受 8 列限制，不遮罩、只給使用者看）；Monitor 與其他排程沒有即時內容，只顯示中繼資料
* 按鍵：清單 ↑↓ 選取、Enter 詳細、Tab 切換最近完成／全部；詳細 ↑↓／PgUp／PgDn 捲動、End 回到跟隨尾端、Ctrl+O 展開工具結果、m 切換對話與中繼資料。Esc：執行中且有即時內容的工作（包含切到中繼資料時）直接關閉面板；已結束或沒有即時內容的工作返回清單；在批次工作的單一任務內返回任務清單
* fullscreen 下宿主預設用 PgUp／PgDn 捲動聊天；載入 Pi Custom Panel 時，面板開啟期間改由面板翻頁（沒載入時請用方向鍵）

清單

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 Jobs · Active / Recent finished
 ▸ ● SH npm run build · …a1b2c3                                        Running · tokens N/A
   ● SA scout · find the entry point · …d4e5f6                        Running · 12.3k tok*
   ✓ SA reviewer · review the diff · …778899                       Completed · 8.1k tok
 ↑↓ Select · Enter Details · Tab Finished/All · Esc Close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

即時內容（對話或輸出）

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 Job details · scout · …d4e5f6
 ▌ <Live conversation / output, max 8 lines, scrollable>
 ▌
 ▌
 Live conversation (memory copy) · Ctrl+O Expand · ↑↓ PgUp PgDn Scroll · End Follow · following
 Esc Close · m Conversation/Metadata · Ctrl+O Expand · Ctrl+C Close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

中繼資料（已結束的工作直接顯示；執行中的工作可用 `m` 切換）

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 Job details · reviewer · …778899
 Job ID: …    State: completed    Activity: …
 Usage: Input … · Output … · Cache read … · Total … · Cost $…
 ↑↓ / PgUp PgDn Scroll · 1-6/18
 Esc Back · m Conversation/Metadata · Ctrl+C Close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

批次工作（parallel／chain）先列任務，Enter 開單一任務

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 Job details · review · 3 concurrent tasks
 3 concurrent tasks · 2 running
 ▸ ● security · running · live · reading src/auth.ts
   ● perf · running · live · profiling
   ✓ docs · completed · done
 Esc Back · ↑↓ Select · Enter Open · Ctrl+C Close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## Settings面板
* 以/settings:web-tools為例
* 使用同一個底部面板外殼的設定指令：`/settings:web-tools`、`/settings:sqlite-tools`、`/settings:sql-connector`、`/settings:remote`、`/settings:auto-compact`、`/settings:schedule-commands`
* 只在按 Ctrl+S 時寫檔，保留沒改的欄位；標題有未存檔變更時加 `●`，有變更時第一次按 Esc 只提示，第二次才放棄
* 欄位型別：布林 `[x]`、列舉 `‹ 值 ›`、數字與文字（Enter 編輯）、機密 `********`（Enter 取代，不顯示既有值）；多頁時 Tab 切頁，只有一頁時不顯示分頁列
* 最下方依序是目前欄位的說明（錯誤訊息用警示色）與按鍵提示

```
── Web Tools ─────────────────────────────────────────────────────────────────────────────────────
 [ Search ]   Fetch

 Search
 ▸ web_search enabled          [x]
    Provider                    ‹ brave ›
    Results                     5
    Search timeout (ms)         60000
 Brave
    Key source                  ‹ key ›
    API key                     ******** (configured; Enter to replace)

 <help text of the focused field>
 ↑/↓ move  Enter/←/→ change  Tab page  Ctrl+S save  Esc close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

單頁、分組的例子：`/settings:schedule-commands`（專案層設定，頂端有說明列）

```
── Schedule Commands ● ───────────────────────────────────────────────────────────────────────────
 Project settings; they override the user-level file. Applied when a session starts.
 General
 ▸ Show in Jobs panel          [x]
   New job scope               ‹ session ›
 Catch-up
   Missed runs                 ‹ skip ›
   Max late (minutes)          60
   Max catch-up runs           10
   Allow run-all for shell     [ ]
 Limits
   Concurrent agents           4
   Concurrent commands         4
   Output tail (KiB)           8

 Show schedules in the Jobs panel under the editor.
 ↑/↓ move  Enter/←/→ change  Ctrl+S save  Esc close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## 詢問問題(例如是否同意權限)
* 本專案的確認、選擇與輸入都用同一個底部面板；宿主自己的權限提問不受影響。非 TUI 時退回宿主對話框，已有面板開著時等它關閉後再顯示
* Yes/No：預設選在 No，避免誤按 Enter 核准；Esc 與 Ctrl+C 視為 No；訊息太長可用 ↑↓／PgUp／PgDn 捲動，不會在看不到全文時核准

```
── Title ─────────────────────────────────────────────────────────────────────────────────────────

 Description

 [ Yes ] [ No ]

 ←/→ choose  Enter confirm  Y yes  N no  Esc cancel
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

單選

```
── Title ─────────────────────────────────────────────────────────────────────────────────────────

 ▸ Option A
   Option B
   Option C

 ↑/↓ PgUp/PgDn move  Enter select  Esc cancel
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

單行文字（Enter 送出、Esc 取消；需要文字時空白不能送出）

```
── Title ─────────────────────────────────────────────────────────────────────────────────────────

 Prompt text
 ❯ typed text_

 Enter submit  Esc cancel  Ctrl+U clear
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

機密輸入（`pty_keyin`）：輸入以 `*` 遮罩，直接送進 PTY，代理看不到

```
── PTY KeyIn ─────────────────────────────────────────────────────────────────────────────────────

 <prompt given by the agent, or "Secret input for PTY session <id> (target local, ... transport)">
 ❯ ********_
 8 chars
 The text you type goes straight to the session; the agent never sees it.
 Enter send  Esc cancel  Ctrl+C/Ctrl+U clear
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## 排程清單（/schedule-commands）
* 底部面板，按鍵 `a` 新增 prompt、`m` 新增 shell、`t` 啟用／停用、`r` 立即執行、`x` 刪除、`c` 清理、Enter 看詳細；動作都經排程工具執行，需要確認時先出現上面的 Yes/No 面板
* monitor 排程不能在面板新增，只能用 `schedule_monitor`

```
── Schedules ─────────────────────────────────────────────────────────────────────────────────────

 ▸ scheduled nightly-report · agent gpt-5 · in 12m | every 1h
   running   build-watch · shell · running
   disabled  weekly-cleanup · prompt · disabled

 ↑/↓ PgUp/PgDn move  Enter details  a prompt  m shell  t on/off  r run  x delete  c clean  Esc close
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

沒有排程時

```
── Schedules ─────────────────────────────────────────────────────────────────────────────────────

 No schedules yet.

 a add a prompt job   m add a shell job   Esc close
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## 背景通知卡片
* Shell、Subagent、Fork、Monitor、排程工作完成或失敗時送回對話的訊息，使用整列背景色（toolSuccessBg／toolErrorBg／toolPendingBg）、含上下內距、不畫框線；這與 Tool Call 不同，Tool Call 沒有背景方塊
* 收合只顯示摘要與最多三行輸出，展開才有工作 ID、目錄與全文；顯示層清除 ANSI 與控制碼，輸出標示為不受信任

```
 ✓ Scheduled shell finished: nightly-backup
 Command (bash): ./backup.sh
 Exit code: 0
 Command output (untrusted):
 backup written: 1024 files
 Expand for job id, directory and the full text
```

---

## Tool Call
* 移除背景方塊
* 所有工具未展開都使用兩行 顯示最重要訊息
以write為例


收合範例
```

● write <FileName>
   1024 byte written...                                                         [Click to expand]

● $ cd /c/GitHub/pi-better-tools && grep -rn "visibleWidth" node_modules/@earen...(timeout 20s)
   Took 0.2s                                                                    [Click to expand]

──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000
```

展開範例

```

● $ cd /c/GitHub/pi-better-tools && grep -rn "visibleWidth"
   node_modules/@earendil-works/pi-tui/dist/*.js 2>/dev/null | head -5 (timeout 20s)

   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:3:import { getGraphemeSegmenter,
   ▌ stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.js";
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:55:                const width =
   ▌ visibleWidth(text);
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:243:        const inputWidth =
   ▌ Math.max(0, innerWidth - visibleWidth(resultText));
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:245:        const inputPadding =
   ▌ " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:252:        let controlsWidth =
   ▌ visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);

   Took 0.2s                                                                   [Click to Collapse]

──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [████░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000
```

---

## 其他
1. Thinking 預設為收合(目前預設為展開)：尚未實作。Pi Custom Panel 載入時不寫任何 settings，需另行決定做法