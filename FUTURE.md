# FUTURE

尚未開工的構想與目前結論。依據為 Pi 1.5.0（`node_modules/@earendil-works/pi-coding-agent`）的型別宣告與 `dist/main.js`、`dist/core/*.js` 原始碼閱讀；未實際試作，未實測。

## 1. 將 SessionManager 從 JSONL 改為 SQLite

### 結論

- **Extension 做不到。** `ctx.sessionManager` 是 `ReadonlySessionManager`（只有 `getCwd`／`getSessionId`／`getBranch`／`getEntries`／`getTree` 等讀取方法），沒有 `append*`，也沒有註冊 storage backend 的 API。
- **`SessionManager` 是寫死 JSONL 的具體 class**：建構式 `private`，直接呼叫 `appendFileSync`／`writeFileSync`／`existsSync`，路徑是內部狀態。
- **啟動路徑寫死。** `dist/main.js` 直接呼叫 `SessionManager.create`／`open`／`continueRecent`／`forkFrom`；`/new`、`/resume`、fork 在 `agent-session-runtime.js`（134／155／204／219 行附近）同樣直接呼叫。
- **SDK 包裝只能換一個 session。** `createAgentSession({ sessionManager })` 可注入，但型別是具體 class（只能 duck typing 或繞過 `private`），且 runtime 內部換 session 時仍退回 JSONL 版本。
- **徹底遷移的路：** fork Pi 並把 `SessionManager` 改成 storage interface／直接換 SQLite，或向上游提 PR 抽出 storage interface。
- **旁路鏡像**（JSONL 當權威、同步寫一份到 SQLite）只能簡化查詢端，不是儲存遷移；目標若是換儲存，鏡像意義有限。

### 若改成 SQLite，本專案要處理的點

- **行號參照 `⟦L<行>:<id>⟧`**：SQLite 逐行存放原始 JSONL（含 header 為第 1 行）、序號嚴格連續、依 session_id 依序讀出，行號即可完全對上。Pi 的 `_rewriteFile`（版本遷移、分支時整檔重寫）發生時，序號要同步整批重建。
- **session 讀取工具**（`session_grep`／`session_window`／`session_read`）：把「開檔逐行讀」換成「查表依序取列」。header 的 `parentSession` 現在存檔案路徑，要改成 session_id 或資料庫位置。
- **若每筆 entry 帶 `workpath`／`parent_session_id`／`session_id`／`type`（primary|subagent|fork）**：祖先鏈、兄弟 session 隔離、跨 session 搜尋、Subagent／Fork transcript 都能簡化成查詢條件。
- **Fork 的真正依賴（修正先前誤述）**：不是父代 session 檔本身，而是 Fork 子行程以 `pi --mode rpc --session <新 jsonl>` 啟動（`modules/fork/src/child.ts:70`），該 jsonl 由 `snapshot.ts` 把父代分支寫成（header 帶 `parentSession`、fork 標記）。子行程用 Pi 內建 `SessionManager.open`，只讀 JSONL。因此 Fork 快照要能從 SQLite 匯出 JSONL，除非子行程也跑修改版 Pi。握手另檢查 `state.sessionFile` 是否存在（`child.ts:196`）。
- **不受影響**：provider 快取身分（用 session id，不是檔案）、Fork `transcript.jsonl`（Fork 自己另寫的輔助檔）。
- **Subagent**：使用者說明同樣是 JSONL，只是目錄不同並有自己的 `transcript.jsonl`；本檔未重新查證其啟動流程。
- **完全丟掉 JSONL 的風險**：`/resume`、session 列表（`SessionManager.list` 掃檔案）與 Pi 內部功能會壞。

### 未查證

- Pi 1.5.0 之外是否有 storage 抽象的計畫。
- 繞過 `private` 建構式做出可用 sqlite 版 `SessionManager` 的工作量。
- 修改版 Pi 的發布方式（決定子行程能否直接讀 SQLite）。

## 2. Subagent／Fork 改為行程內物件啟動

### 結論

- 可能更快，但**未實測**，以下為依架構的推論。
- **可能的好處**：省下啟動 Node 行程與重載全部 extension（本專案測試經驗是時間主要花在每次啟動載入）、省記憶體；SessionManager 若已是 SQLite，可用 `createAgentSession({ sessionManager })` 直接注入，免匯出 JSONL；Fork 的快取身分覆寫可在建立時設定，不必靠子行程 guard 改標頭。
- **代價（來自現有保障）**：
  - 取消與清理：殺行程能終止子代與其工具，行程內只能協作式中止，同步程式碼卡住或掛住的 shell 子行程停不掉。
  - 隔離：子代崩潰、無窮迴圈或阻塞事件迴圈會拖垮主代理 TUI。
  - 共享狀態：Node 模組快取共用，模組層單例（registry、tracker、快取）需逐一檢查。
  - 前綴一致：Fork 要求子代工具定義與父代逐字相同才能延續 provider 快取，行程內要保證兩個 session 的 resource loader 產出完全一致。
  - 保障要重寫：`--exclude-tools subagent` 防遞迴、32 submitted／8 active 上限、串流背壓、guard 握手，現在靠行程邊界與參數，要換成物件層實作。
- **先例**：第三方 Schedule Prompt 已是行程內 in-process subagent，AGENTS.md 規定不得與 Subagents 的行程保障混為一談。

### 建議順序

1. 若 fork Pi 換 SQLite，**先只做儲存**；子代維持行程，Fork 快照改為從 SQLite 匯出 JSONL（或修改版 Pi 的子行程直接讀同一資料庫）。
2. 行程內啟動當成**之後的獨立優化**：先量測子代啟動耗時佔比，再決定值不值得放棄行程隔離。

## 3. 用 tmux 包裝 Pi（Subagent／Fork／Shell 即時顯示）

最終構想：以 tmux 包裝 Pi，讓 Subagent／Fork／Shell 都在 pane 內啟動，可在畫面上即時看到所有任務進行狀況。以下為架構推論，未實作、未實測。

### 現況限制

- Subagent／Fork 子行程目前是 `pi --mode rpc`，經 stdio 傳 JSON 與父代溝通；RPC 模式沒有 TUI，放進 pane 也看不到畫面。

### 做法一：tmux 只負責顯示（推薦）

- 子行程照舊 RPC，父代照舊控制（握手、取消、`fork_message`、結果回傳），現有保障全保留。
- pane 只跑檢視器（例如 `tail -f` 子代 transcript，或渲染 session 檔）。
- 優點：改動小、不動控制語意、不依賴 `send-keys`／`capture-pane`。缺點：看到的是日誌渲染，不是子代真正的 TUI，也不能在 pane 內直接互動。

### 做法二：pane 內跑完整互動式 Pi

- 畫面是子代真正的 TUI，可直接介入。
- 代價：失去 RPC 結構化通道，父代需改用 socket／named pipe／檔案控制；結果必須走結構化通道，不可靠 `send-keys` 送指令、`capture-pane` 讀結果（換行、捲動、ANSI 控制碼會污染，且有注入風險）。
- 取消、process tree 清理、Fork 的工具前綴一致與快取身分覆寫，都要重新設計。

### Shell

- 放進 pane 最自然（即時輸出可見），但退出碼、`timeoutMs`、輸出擷取要自行處理：`pipe-pane` 同步寫檔，加標記行或 `tmux wait-for` 取得完成訊號。可評估與既有 PTY 模組共用。

### 平台

- tmux 無原生 Windows 版，需 WSL（影響路徑對應、Node 環境、Pi 跑在哪一側）。替代：Windows Terminal `wt.exe` 分割窗格、WezTerm（自有 pane API）、Windows 上的 tmux 相容實作。可用程度未查證。動工前先讀 Pi 的 `docs/tmux.md`、`docs/windows.md`（本次未讀）。

### 建議

- 控制面（RPC）與顯示面（tmux pane）分離；先做做法一，驗證「即時看到所有任務」是否為所需體驗，需要直接介入子代時再單獨評估做法二。

## 4. Fork Pi 後如何跟上 upstream

前提（使用者所知，未查證）：Pi 基本不接受外部 PR，所以「把 storage interface 送回上游」這條路走不通，只能長期自己維護 fork。以下為通用的 fork 維護做法，未實作。

### 基本流程

- fork 保留 `upstream` remote；修改放獨立分支（例如 `sqlite-session`），不直接改 `main`。
- 原專案發新版時 `git fetch upstream`，把分支 `rebase`（或 `merge`）到新的 upstream tag。以 tag 對齊發布版本，不追每個 commit；本專案只驗證單一 Pi 版本（目前 1.5.0），一次跟一個正式版即可。

### 縮小衝突面（最重要）

- 先在 `session-manager.ts` 外加一層 storage interface，JSONL 與 SQLite 各一個實作；樹狀結構、`buildSessionContext`、分支等原邏輯盡量不動。
- 新增程式放**新檔案**（例如 `session-storage-sqlite.ts`），新檔案不會產生合併衝突；對既有檔案只改最少幾行（如把 `appendFileSync` 換成呼叫 interface）。
- `main.js`、`agent-session-runtime.js` 裡寫死的 `SessionManager.create`／`open` 改走工廠函式，只動呼叫點。

### 降低長期成本

- 無法靠上游接受 PR 縮小差異，因此更要讓改動集中、可預期。
- 啟用 `git rerere` 記住衝突解法。
- 在 fork 內加 session 行為測試（分支、壓縮、行號對應、resume），每次 rebase 後跑一次。
- 另維護 `CHANGES.md`，列出所有改動的檔案與原因，升級時知道要檢查哪裡。

### 對本專案的影響

- 換成自己的 fork 後要決定發布名稱（不能沿用原套件名）並更新 peer 依賴。
- 每次升級 Pi 版本都要重跑本專案測試組（含重型組）；依 Pi 內部細節寫的測試（如 compaction 門檻與 `getCompactionSettings` 的對照）能提早發現不一致。

### 風險

- 最大風險是 upstream 大幅重構 `session-manager.ts`（改檔案格式或事件機制），屆時 rebase 變成重新移植。由於無法上游化，只能靠「改動集中、新檔案為主、測試完整」降低成本。
- 未查證：Pi 的發版頻率與近期 `session-manager.ts` 的變動幅度，動工前先看 changelog。

## 5. 整體路線：兩條彼此獨立的線

使用者構想的三步（fork Pi 改 SessionManager → fork 版 SDK 外套 node mux 殼 → Subagent／Fork／Shell 改用 mux 啟動）不是唯一路徑，也不是一條鏈；實際是兩條獨立的線（架構推論，未實作）。

```
A 線（即時顯示）：寫 node mux → extension 改用 mux 開 pane   ← 原版 Pi 即可
B 線（儲存換 SQLite）：fork Pi 改 SessionManager             ← 與 A 線無關
```

### A 線不需要 fork Pi

- mux 是終端包裝器：開 PTY、跑 `pi`、排版畫面；對 mux 而言 pane 內的 Pi 只是一般行程，原版 Pi 即可，不需要 SDK。只有想把 Pi 嵌入 mux 行程內（`createAgentSession`）才用 SDK，但會失去 Pi 自己的 CLI 流程，不建議。
- Subagent／Fork／Shell 改用 mux 的改動在本套件的 extension 內完成：仿 tmux 的 `$TMUX`，mux 啟動 pane 時設環境變數指向其 socket；extension 偵測到就請 mux 開 pane，偵測不到退回現有行程啟動。
- 控制面（RPC、握手、取消）維持 stdio／socket；pane 只是顯示面（見第 3 節）。

### B 線只有要換儲存時才需要

- fork Pi 與維護成本見第 1、4 節。與 mux 無關。

### 交會點

- 兩條線都完成時，Fork 快照要從 SQLite 匯出 JSONL，或讓子行程跑修改版 Pi。

### 建議順序

1. 先做 A 線：風險小、不需維護 Pi fork、成果立即可見，並能達成「畫面上即時看到所有任務」。
2. B 線等確定真的需要 SQLite 儲存（而非只是更好的查詢）再做。
3. 未驗證：Windows ConPTY 與 CJK 寬度等細節可能改變 mux 的工作量估計。

## 6. 整合專案：Pi SDK ＋ pi-mux ＋ better-tools

前提：`C:\GitHub\pi-mux`（已實作 MVP，22 個 e2e 與單元測試通過，OSC 7501 程式狀態為使用者要求，使用者已自行啟動看過）與本專案維持各自獨立；日後以兩者為基礎另開一個整合專案。以下為構想與推論，未實作。

### 構想

1. 啟動時直接用 Pi SDK 啟動主 agent。
2. 注入與 mux 深度整合的 better-tools：Shell／Subagent／Fork 直接與 mux 整合。
3. 注入 mux extension，讓 Pi 能用 tool 讀取與操作 mux 視窗。

### 1. SDK 啟動主 agent

- Pi 1.5.0 的 `dist/index.d.ts` 匯出 `InteractiveMode`、`runPrintMode`、`runRpcMode`、`createAgentSessionRuntime`、`createAgentSessionServices`，也匯出 `main` 與 `MainOptions`。
- 兩種做法：呼叫 `main(args, options)`（保留 Pi 完整 CLI 流程：參數、settings、resume 選擇器，只在 `MainOptions` 允許處注入）；或自己組 runtime 加 `InteractiveMode`（控制力最大，但 CLI 啟動流程要自己重做）。
- 未查證：`MainOptions` 能注入哪些 extension 與選項。動工前先讀，它決定整合專案進入點的形狀。

### 2. Shell／Subagent／Fork 與 mux 整合

- 主代理在 mux pane 內，靠環境變數 `PI_MUX` 偵測 mux；偵測不到就退回現有行程啟動。
- 控制面與顯示面仍分開：RPC 握手、取消、結果回傳留在原通道，pane 負責顯示；若子行程改在 pane 內跑互動式 Pi，需另建結構化通道（見第 3 節做法二）。
- 現有保障要逐項決定怎麼搬：`--exclude-tools subagent`、32 submitted／8 active 上限、串流背壓、Fork 工具前綴一致與快取身分覆寫、guard 握手。這是整合專案最大的工作量。

### 3. mux extension（Pi 用 tool 操作 mux）

- `pi-mux/src/api.mjs` 已有 client 函式庫，可包成 `mux_list`／`mux_capture`／`mux_send_keys`／`mux_split`／`mux_wait` 等 tool。
- 安全設計必須先做：pane 內任何程式都讀得到 token（`PI_MUX_TOKEN_FILE`），agent 能 `send-keys` 就等於能在任一 pane 執行任何東西，會繞過 Shell 的授權模型。需決定哪些 pane 對 agent 可見、可操作（例如只開放它自己建立的 pane）。
- `capture-pane` 讀到的畫面是不受信任資料（其他程式輸出可能含提示注入），依專案原則標示來源。
- 註冊方式（`defaultActive` 或 deferred）依專案的 deferred 機制決定，不得擅自啟用。

### 建議順序

1. 先讀 `MainOptions`，確認 `main()` 能注入什麼。
2. 兩個專案維持獨立，整合專案只依賴公開介面（`pi-mux` 的 API、better-tools 的 extension）。
3. 先做第 3 點（mux 操作 tool）作最小驗證：不動既有 Subagent／Fork／Shell，風險最低。

### 附：用 OSC 7501 讀取 Subagent／Fork／Shell 狀態

結論：可用，但只當**顯示用的輔助訊號**，不能當完成與否的依據。以下為推論，未實作。

- **mux 現況**：pi-mux 已儲存每個 pane 的 OSC 7501 狀態（`working`／`blocked`／`done`／`error`／`idle`），`list` 回傳 `status`，`wait` 支援 `until:"state"`，狀態列顯示。ConPTY 丟掉 OSC 只發生在輸入端（mux 對查詢的回覆送不到程式）；程式往外送的方向 mux 收得到。
- **誰來送**：
  - Shell：命令包一層，執行前送 `working`，結束依退出碼送 `done`／`error`。不需改 Shell 本體；但 mux 本來就知道 `exited`／`exitCode`，價值主要在 `working` 與進度。
  - Subagent／Fork：子行程內的 guard extension 在生命週期事件送（agent 開始、工具呼叫、等待授權或確認時 `blocked`、結束 `done`／`error`）。最有價值的是 `blocked`：子代等確認時，狀態列立刻看得到。
- **限制**：
  1. 目前 `pi --mode rpc` 子行程的 stdout 是 JSON 通道，混入 OSC 會破壞協定；需在 pane 內跑互動式 Pi，或另開寫到 pane 終端的路徑。
  2. Pi 的 TUI 自己控制 stdout，extension 直接寫 escape 序列是否干擾重繪**未驗證**；pi-mux README 也寫「Pi 本身是否送出這個序列不知道」。
  3. 自我回報不是權威狀態：背景通知不等於 runner 完成，完成、結果、退出碼仍以各模組 job registry 與 mux 的 `exitCode` 為準；OSC 7501 只用於 `working`／`blocked`／進度，以及讓 `wait until=state` 提早得知卡在確認。
  4. `msg` 等自由文字是不受信任資料，顯示時沿用 mux 現有的控制字元過濾，不原樣餵給模型。
- **建議**：整合專案做到「Shell／Subagent／Fork 在 pane 內跑」時再加 guard extension 發 OSC 7501；先用 Shell 包裝做最小驗證（不涉及 Pi 的 TUI 與 RPC 通道）。

## 7. mux-text 實驗：專用 extension 剝掉 TUI ＋ 資料通道（已實測）

需求：Subagent／Fork 在 mux pane 內只顯示純對話串流，執行資料與畫面分成兩條通道。第 3 節「做法二」原本認為放棄 RPC 就失去結構化通道；本節實測證明可用專用 extension 補回。分支 `mux-text`，程式在 `tools/mux-text-spike/`（`viewer-ext.ts`、`run.mjs`、`run2.mjs`），離線 provider、不呼叫真實模型。

### 做法

- 子代跑**完整互動式 Pi**（mux 在 PTY 內啟動），載入專用 extension。
- 顯示面：`ctx.mode === "tui"` 時呼叫 `setHeader`／`setFooter`（空元件）、`setEditorComponent`（`render()` 回傳 `[]` 的空輸入框）、`setWorkingVisible(false)`、`onTerminalInput`。
- 控制面：extension 在 `session_start` 連回父代開的 loopback socket（JSONL），不經 stdout。

### 實測結果（Windows、Pi 1.5.0）

| 項目 | 結果 |
|---|---|
| 剝除 UI | 以 xterm headless 還原最終畫面，只剩對話；標頭、輸入框框線、頁尾、工作中轉圈都消失。啟動訊息（`[Extensions]`、未信任提示）仍在；Fork 子行程本來就帶 `--approve`，信任提示不會出現，`[Extensions]` 清單能否關閉未試 |
| prompt／事件 | `pi.sendUserMessage` 觸發完整一輪；`agent_start`、`message_end`、`agent_settled` 轉送給父代 |
| abort | `ctx.abort()` 中止串流，assistant 訊息 `stopReason:"aborted"`，隨後 `agent_settled` |
| steer／followUp | `sendUserMessage(..., {deliverAs})`。有工具呼叫時（序列執行）steer 不跳過剩餘工具，整批跑完後、下一次模型呼叫前插入；followUp 在模型最終回答後才插入。語意與 RPC `steer`（`rpc-commands.md`）一致 |
| usage | `getSessionStats()` 只是對 session entries 加總；extension 用 `ctx.sessionManager.getEntries()` 以同樣算式得到 `tokens`／`cost`，另有 `ctx.getContextUsage()`。預期值吻合（5 次請求 total 90、cost 0.005） |
| 按鍵 | Esc、Ctrl+C（單次與兩次）、Ctrl+D、Ctrl+Z、Ctrl+L、Shift+Tab 在串流中都不影響串流，行程仍在。基準（預設輸入框）下 Esc 確實中止串流，證明按鍵有送達。**光換掉輸入框就足夠**，快捷鍵處理器掛在預設輸入框上；`onTerminalInput` 在此測試沒有額外效果 |

### 未驗證

- 通道認證：目前是無認證的 loopback TCP。正式版要 named pipe 或 token，否則本機其他行程可送 prompt。
- 與 Fork 握手的整合：工具集逐字比對、provider 快取身分覆寫、`--tools`／deferred 工具。
- 真實模型下的工具呼叫畫面渲染；usage 沒與同 session 的 RPC `get_session_stats` 並排比對。
- 只測七組按鍵，沒測滑鼠、貼上、使用者自訂 keybindings。
- `abort` 使用 `session_start` 取得的 `ctx`；換 session（`/new`、`/resume`）後可能失效，Fork 子行程不換 session，影響不大。
- 基準組的 Ctrl+C ×2 沒有明確結果（腳本中途停止），不宣稱預設會退出。
- 單次、單機器、離線；穩定性與 ConPTY 的 CJK 寬度未測。

### 對路線的影響

- 取代 RPC 控制面所需的動作（prompt、steer、followUp、abort、事件、usage）都有對應 API，第 3 節做法二的主要阻礙解除；代價仍是取消／process tree 清理、背壓、握手要在新通道上重做。
- 仍建議先做 Shell，再依本節結果評估 Subagent／Fork；RPC 子行程在整合完成前保持不動。
