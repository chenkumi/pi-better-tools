# Fork（原生）

入口 `modules/fork/src/index.ts`；僅支援 Pi **1.1.0**。以**獨立 Pi 行程**接手一項任務：繼承來源對話（目前 active branch 的完整紀錄）、有效 model／thinking／cwd、工具選取與 resources，原 Pi 持續開啟時，切換到其他 session 後 Fork 仍繼續，完成後回報**原 session**。不是清空 context 的 Subagent，也不是 OS sandbox。

## 工具

| 工具 | 說明 |
|---|---|
| `fork { task, title? }` | 固定非同步。回傳 `jobId` 與預先配置的 `forkSessionId`（uppercase ULID），狀態 `awaiting_snapshot`。沒有 agent／cwd／model override。 |
| `fork_status { jobId? }` | 唯讀：只列出**本 session** 建立的 Fork（最多 32）；帶 `jobId` 才含有界結果。 |
| `fork_cancel { jobId }` | 取消**要求**。狀態維持 `cancelling` 直到實際觀察到 child `close`；requested 不等於已退出。 |

三個工具均 `defaultActive:false`：須由使用者以 `--tools`／`defaultTools`／`/tools` 明確選取，載入本模組不會自行啟用任何工具。

## 行為

1. **快照時機**：`fork` 只受理並保存 metadata，不立即 spawn。在該回合的 `turn_end`（工具結果已 canonical 寫入）才複製 active branch：條目逐筆原樣保留（含 compaction、圖片、opaque provider metadata），不混入其他分支，不改寫來源檔；尚未配對的 tool call 會被拒絕，不捏造結果。等待期間若換 session／分支，改以 `SNAPSHOT_ORIGIN_LOST`／`SNAPSHOT_BRANCH_CHANGED` 失敗。
2. **原生對話**：新 JSONL 寫在來源 session 的有效 sessionDir，header `cwd` 為同一 workspace、`parentSession` 指向來源，末尾加一筆 `pi-better-tools.fork-origin` custom entry。Fork 是單一可寫權威檔，原生 `/resume` 可發現；完成後可載入繼續。執行中不要用 `/resume` 當 live attach（會是第二個 writer）。
3. **能力繼承**：child 以 `--mode rpc --session <fork> --model <provider/id> --thinking <level> --tools <父代 active 工具，去除 Fork 工具> --approve|--no-approve` 啟動，並轉送父代啟動時的資源旗標（`-e/--extension`、`--skill`、`--prompt-template`、`--theme`、`--no-*` 資源旗標、`--system-prompt`／`--append-system-prompt`；行內提示文字改以 owner-only 檔案傳遞，不放 command line）。任務文字走 RPC stdin，不進 command line。child 啟動後、**第一個 provider request 前**由 guard 驗證 model／cwd／session id／thinking／trust／工具集合完全相等／起源標記；任一不符以 `MODEL_UNAVAILABLE`、`CONFIG_CHANGED`、`TRUST_REQUIRED`、`CAPABILITY_MISMATCH`… 拒絕並退出，父代不會送出 prompt。透過 inline SDK factory 提供、無法在另一行程重建的工具，在受理前以 `FORK_CAPABILITY_UNAVAILABLE` 拒絕。不繼承 OS handles、執行中 jobs、一次性 approval 或 credentials。
4. **Fork 可用 `subagent`，不可再 Fork**：Fork child 保留父代的 `subagent` 選取，由自己的 session 擁有新派遣的子代理。所有 Subagent child（new／resume／ready-query）由既有 argument builder 加上 `--exclude-tools …,fork,fork_status,fork_cancel`；Fork child 以 `--exclude-tools fork,fork_status,fork_cancel` 啟動。另有 execute guard：managed Subagent 握手、Fork 啟動握手（process-local、不被後代繼承）、或 session 內的起源標記（cold `/resume` 的 Fork 對話）任一存在即拒絕。這是工具契約，不是 OS sandbox——有 shell 權限者仍可自行啟動 Pi。
5. **完成判定**：child 的 guard 在 `agent_settled` 時檢查自己 session 的 Shell／Subagent 未完成工作數（經 `activeJobCounts` 唯讀計數橋，僅計數，不暴露 handle、輸出或取消能力）。有未完成工作時不發布成功；工作自身的 wake-up 會再次 settle，若工作結束但未喚醒，需連續兩次 quiet 才視為完成。完成後才取最後 assistant 文字與用量（`get_session_stats` 前後差值，繼承歷史不重複計入）、關閉 stdin、等待真實 `close`。第三方任意 OS 工作不宣稱可完整追蹤。
6. **回報**：以 origin `sessionId`＋native file＋canonical cwd 比對目前有效 binding。原 session 前景時送 `customType:"fork-result"` 通知（`display:true`，帶 `details.resultId`，內容標示為 delegated data、非指令；`triggerTurn:true`／`followUp`）。不在前景時只保存 pending，切回原 session 的 `session_start` 才投遞，**絕不**送進別的 session，也不在背景額外啟動 parent 模型。投遞前掃原生 journal 以 `resultId` 去重；submission 不等於 host durable ack，未知狀態不 blind replay。
7. **生命週期**：Fork 管理器是行程層級（`globalThis` 上的 plain state），跨 `new`／`resume`／原生 fork／不同 cwd 的 session replacement 保留。`quit`／`reload` 先同步撤銷 binding、關閉 admission，再對**全部**未完成 Fork 扇出取消並等待（個別失敗不中斷其餘）。重新啟動 Pi 不重跑任何舊任務：磁碟紀錄中 owner 已不存在的進行中工作在下次進入原 session 時標為 `interrupted`，已完成但未送達的結果會在該 session 回報。
8. **限額**：每個 Pi 行程最多 4 個未完成 Fork（取消中、close 未確認者仍佔額度）、保留 32 筆；task 最大 100 KiB；結果最多 32 KiB；`fork_status` 最多列 32 筆。child stdout 逐行有界（單行 4 MiB，超過即丟棄並持續排空）、stderr 只留 8 KiB 尾端。Fork 自己派遣的 Subagent 仍受該 child 行程既有 32 submitted／8 active 限制；本模組的額度不是整棵程序樹的全域配額。

## 儲存

- 原生對話：來源 session 的 sessionDir 內一份 JSONL。
- Metadata／結果：`<cwd>/.pi/forks/<jobId>.json`（owner-only、原子替換）：role／origin／設定指紋（工具名單雜湊，非內容）／狀態／有界結果／用量／cleanup 證據／delivery 狀態。任務文字只保存 500 字預覽；不保存 credentials。
- 不寫入使用者全域 settings／auth／排程資料。

## 部署與限制（CP1 實測）

- 支援拓樸：Pi 1.1.0 CLI＋單一 active `AgentSessionRuntime`，且**每個 session 都載入本管理入口**。目標 session 若不載入本 extension（例如專案 package 設定將其排除），該 session 的 `/reload`／quit 不會取消 Fork；本模組不以 monkey-patch 補洞，也不暗中載入被排除的 extension。
- 裸 `AgentSession.dispose()` 不發 `session_shutdown`，不在支援範圍；強制退出（emergency exit／crash）無法經一般 extension cleanup。child 的 RPC stdin EOF 是最低成本 lifeline：父行程真正結束時 child 自行 shutdown，但不保證強制 kill、停滯 JS 或繼承 pipe 的第三方 descendants 已結束。
- TUI 在回應中或 compaction 時 `/reload` 會被宿主拒絕，不算 reload。
- 取消流程：`abort` RPC → stdin EOF → 等待 `close`（10 秒）→ `SIGTERM`（5 秒）→ `SIGKILL`；Windows 以 `taskkill /T`。仍沒有 `close` 時 `cleanup.childClosed:false`，permit 保留，**不**宣稱整棵程序樹已停止。
- Fork 與 parent 共用 workspace：不自動建立 worktree、不合併檔案、不同步 parent 後續訊息；並行寫同一檔案需自行協調。
- 通知使用 `triggerTurn:true`：parent 前景閒置時完成通知會喚醒 parent 一個回合（與 Subagent 背景完成通知一致）。

## 驗證

`npm run test:module -- fork`：strict typecheck、單元（角色矩陣、快照、參數建構、child 狀態機、guard、manager 生命週期）與真實 Pi 1.1.0 離線整合（快照／獨立 child／回報／A→new→A 只回報來源／quit 取消與 child close／巢狀 background shell 完成前不發布／cold `/resume` 仍拒絕 Fork）。使用隔離 HOME／agentDir／workspace 與本地假 provider，不使用真實 credentials。人工 TUI、真實 provider 與其他 OS 未由這些測試證明。
