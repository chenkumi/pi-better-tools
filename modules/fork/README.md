# Fork（原生）

入口 `modules/fork/src/index.ts`；僅支援 Pi **1.1.0**。以**獨立 Pi 行程**接手一項任務：繼承來源對話（目前 active branch 的完整紀錄）、有效 model／thinking／cwd、工具選取與 resources，原 Pi 持續開啟時，切換到其他 session 後 Fork 仍繼續，完成後回報**原 session**。不是清空 context 的 Subagent，也不是 OS sandbox。

## 工具

| 工具 | 說明 |
|---|---|
| `fork { task, title? }` | 固定非同步。回傳 `jobId`、預先配置的 `forkSessionId`（uppercase ULID）與 `transcriptPath`，狀態 `awaiting_snapshot`。沒有 agent／cwd／model override。 |
| `fork_status { jobId? }` | 唯讀：只列出**本 session** 建立的 Fork（最多 32，含 `transcript` 路徑與狀態）；帶 `jobId` 才含有界結果。 |
| `fork_cancel { jobId }` | 取消**要求**。狀態維持 `cancelling` 直到實際觀察到 child `close`；requested 不等於已退出。 |
| `fork_message { jobId, message, mode? }` | 對**執行中**（`running`／`blocked`）的 Fork 追加一則指示。`mode` 預設 `follow_up`（等目前回合結束），`steer` 會打斷目前回合並放棄進行中的工具鏈。回傳 receipt（`messageId`、`status`）。 |

四個工具均 `defaultActive:true`：載入本模組後預設啟用，不需新增 config；宿主的 `--tools` allowlist、`--exclude-tools`、`--no-tools` 與手動停用仍優先，不強制改寫工具選取。Subagent／Fork child 仍不註冊這四個工具。

## 行為

1. **快照時機**：`fork` 只受理並保存 metadata，不立即 spawn。在該回合的 `turn_end`（工具結果已 canonical 寫入）才複製 active branch：條目逐筆原樣保留（含 compaction、圖片、opaque provider metadata），不混入其他分支，不改寫來源檔；尚未配對的 tool call 會被拒絕，不捏造結果。等待期間若換 session／分支，改以 `SNAPSHOT_ORIGIN_LOST`／`SNAPSHOT_BRANCH_CHANGED` 失敗。
2. **原生對話**：新 JSONL 寫在來源 session 的有效 sessionDir，header `cwd` 為同一 workspace、`parentSession` 指向來源，末尾加一筆 `pi-better-tools.fork-origin` custom entry。Fork 是單一可寫權威檔，原生 `/resume` 可發現；完成後可載入繼續。執行中不要用 `/resume` 當 live attach（會是第二個 writer）。
3. **能力繼承**：child 以 `--mode rpc --session <fork> --model <provider/id> --thinking <level> --tools <父代 active 工具，去除 Fork 工具> --approve|--no-approve` 啟動，並轉送父代啟動時的資源旗標（`-e/--extension`、`--skill`、`--prompt-template`、`--theme`、`--no-*` 資源旗標、`--system-prompt`／`--append-system-prompt`；行內提示文字改以 owner-only 檔案傳遞，不放 command line）。任務文字走 RPC stdin，不進 command line。任務提示以身份宣告開頭（`You are the background Fork.`）：明說繼承歷史中的 `fork` 呼叫與結果就是自己被啟動的過程、自己就是父代等待的背景 agent、不要等待或輪詢任何背景回報、不可再 Fork，並要求最後一則訊息為回報給父代的簡明結果；否則 child 會讀到「結果將回報到此對話」的 tool result 而誤以為在等別人。child 啟動後、**第一個 provider request 前**由 guard 驗證 model／cwd／session id／thinking／trust／工具集合完全相等／起源標記；任一不符以 `MODEL_UNAVAILABLE`、`CONFIG_CHANGED`、`TRUST_REQUIRED`、`CAPABILITY_MISMATCH`… 拒絕並退出，父代不會送出 prompt。透過 inline SDK factory 提供、無法在另一行程重建的工具，在受理前以 `FORK_CAPABILITY_UNAVAILABLE` 拒絕。不繼承 OS handles、執行中 jobs、一次性 approval 或 credentials。
4. **Fork 可用 `subagent`，不可再 Fork**：Fork child 保留父代的 `subagent` 選取，由自己的 session 擁有新派遣的子代理。所有 Subagent child（new／resume／ready-query）由既有 argument builder 加上 `--exclude-tools …,fork,fork_status,fork_cancel,fork_message`；Fork child 以 `--exclude-tools fork,fork_status,fork_cancel,fork_message` 啟動。另有 execute guard：managed Subagent 握手、Fork 啟動握手（process-local、不被後代繼承）、或 session 內的起源標記（cold `/resume` 的 Fork 對話）任一存在即拒絕。這是工具契約，不是 OS sandbox——有 shell 權限者仍可自行啟動 Pi。
5. **完成判定**：child 的 guard 在 `agent_settled` 時檢查自己 session 的 Shell／Subagent 未完成工作數（經 `activeJobCounts` 唯讀計數橋，僅計數，不暴露 handle、輸出或取消能力）。有未完成工作時不發布成功；工作自身的 wake-up 會再次 settle，若工作結束但未喚醒，需連續兩次 quiet 才視為完成。完成後才取最後 assistant 文字與用量（`get_session_stats` 前後差值，繼承歷史不重複計入）、關閉 stdin、等待真實 `close`。第三方任意 OS 工作不宣稱可完整追蹤。
   **`blocked`（非終端真相回報）**：settlement 必須等 quiet，因此巢狀工作還在跑時，模型已經失敗這件事原本完全看不出來。guard 因此改為：當最後一則 assistant 的 `stopReason` 為 `error` 且未完成工作數 > 0，不等 quiet，立即送出非終端的 `blocked` 訊號（`reason`、有界 300 字元錯誤文字、`pending` 計數）；計數或錯誤改變才重送，避免 IPC 噪音。狀態誠實是雙向的：一且後續 turn 成功（工作仍可能在跑），guard 送出 `unblocked`，父代把狀態還原為 `running` 並清掉 blocked 真相。`blocked` **永不**等於成功，也不取代既有的 quiet 與連續兩次規則。
6. **顯示（TUI）**：進行中 Fork 以共用背景工作面板（`FK`，與 Subagent／Shell 同一 above-editor 面板，`/background-jobs fork` 篩選）呈現，僅 TUI＋hasUI，不讀任務／結果內文、不輪詢、不發模型請求；UI 例外不改變 Fork 結果、投遞或 permit。`fork-result` 通知以 `registerMessageRenderer` 套用與 Shell 完成通知一致的有色面板（✓／✗／!、用量、原生對話路徑；收合顯示輸出末 3 行，展開顯示全文），只改顯示，不改模型可見訊息。
7. **回報**：以 origin `sessionId`＋native file＋canonical cwd 比對目前有效 binding。原 session 前景時送 `customType:"fork-result"` 通知（`display:true`，帶 `details.resultId`，內容標示為 delegated data、非指令；`triggerTurn:true`／`steer`）。不在前景時只保存 pending，切回原 session 的 `session_start` 才投遞，**絕不**送進別的 session，也不在背景額外啟動 parent 模型。投遞前掃原生 journal 以 `resultId` 去重；submission 不等於 host durable ack，未知狀態不 blind replay。
8. **查詢用 transcript**：與 Subagent 的 readable log 同格式（重用其 v2 writer：`user`／`assistant`／`tool_call`／`tool_result` JSONL），但**只記 Fork 開始後的對話**：child 收到任務後的每則完成訊息（第一筆 `user` 就是任務提示）；繼承的上下文不複製，仍在原生對話裡。路徑 `<cwd>/.pi/forks/<jobId>/transcript.jsonl` 於 `fork` 回傳時即揭露；執行中寫在 `transcript.jsonl.partial`（`fork_status` 的 `transcript.livePath`），Fork 結束並同步後才原子改名，完成通知（文字與 `details.transcriptPath`）只在改名完成後宣告最終路徑。Fork 內的 Subagent 有自己的 log，這裡只有其 `subagent` tool call／result。圖片與 base64 以標記省略；單筆內容超過 128 KiB 截短並標示，過大的 tool 參數改記大小。這是輔助檔：開檔失敗、寫入錯誤或啟動前積壓超過 256 筆，只把 `transcript.state` 標為 `unavailable`（附原因，可能留下 `.partial`），**不**讓 Fork 失敗或延後結果；最終改名（開檔、同步、rename）有 5 秒上限，逾時只標為 `unavailable`，不阻塞通知、quit 或 reload；child 未確認關閉（`cleanup.childClosed:false`）時 child 可能仍在寫入，故不改名、不宣告最終路徑，僅保留 `.partial` 並標為 `unavailable`（原因為可能不完整）。owner 已消失的進行中 Fork 在下次載入時同樣標為 `unavailable`。定稿（同步＋改名）最多等 5 秒，逾時同樣只標 `unavailable`，不阻塞結果投遞或 quit／reload；child 的 `close` 未被確認（例如取消階梯放棄）時，因 child 仍可能續寫，不改名為最終檔，只保留 `.partial` 並標為 `unavailable`（原因註明可能不完整）。可能含程式碼、工具輸出或憑證，分享前請自行檢查。
9. **生命週期**：Fork 管理器是行程層級（`globalThis` 上的 plain state），跨 `new`／`resume`／原生 fork／不同 cwd 的 session replacement 保留。`quit`／`reload` 先同步撤銷 binding、關閉 admission，再對**全部**未完成 Fork 扇出取消並等待（個別失敗不中斷其餘）。重新啟動 Pi 不重跑任何舊任務：磁碟紀錄中 owner 已不存在的進行中工作在下次進入原 session 時標為 `interrupted`，已完成但未送達的結果會在該 session 回報。
10. **限額**：每個 Pi 行程最多 4 個未完成 Fork（取消中、close 未確認者仍佔額度）、保留 32 筆；task 最大 100 KiB；結果最多 32 KiB；`fork_status` 最多列 32 筆。child stdout 逐行有界（單行上限 4Mi 個 UTF-16 code units，以解碼後字串長度計、不是 UTF-8 位元組，CJK／emoji 行的實際位元組可達約 3 倍；超過即丟棄並持續排空）、stderr 只留 8 KiB 尾端。Fork 自己派遣的 Subagent 仍受該 child 行程既有 32 submitted／8 active 限制；本模組的額度不是整棵程序樹的全域配額。
11. **追加訊息（`fork_message`）**：只受理 `running`／`blocked`，其餘狀態（含 `awaiting_snapshot`／`starting`／`finalizing`／`cancelling` 與終態）一律 `FORK_BUSY`／`FORK_NOT_RUNNING` 拒絕，**不排隊、不重試、不重播**；每個 Fork 上限 32 則。訊息經既有 `--mode rpc` 的 `RpcPipe` 送入 child（`follow_up`／`steer`），文字加上既有 `[Delegated user control <id>]` 前綴，`validateInteraction` 限制非空白文字 ≤ 64 KiB；child 尚未送出任務前以 `CHILD_NOT_READY` 拒絕，避免早到的訊息被第一個 prompt 吃掉。**受理不等於套用**：receipt 的 `status` 是 child 回報的 `queued`／`not_applied`／`delivery_unknown`（含 `RPC_DEADLINE`／`RPC_CLOSED` 等傳輸錯誤），只有 child 自己收到該文字（user 訊息逐字相符）才升級為 `applied`；`accepted`／`delivery_unknown` 都不改 `status`、`cancelRequested` 或 `blocked`，不假裝進展。receipt 只存記憶體（上限 32），不寫 metadata、不跨 reload；`fork_status` 顯示最近 3 則（短 `messageId`、`status`）。它不是取消、不喚醒 parent，完成仍只經 `fork-result`；相反地，被注入的訊息會讓 guard 的 quiet 判定不成立，因此不會提前結束。

面板的 owner-bound `bind`／`refresh`／`clear` 與 Shell／Subagents 共用 `modules/shell-tools/src/widget-binding.ts`；Fork 仍獨立提供 job 投影、origin binding、permit／child-close 判定、取消與投遞，不建立共用 execution registry。

詳細頁可另顯示 Fork 的**即時對話副本**（`src/manager.ts` 的 `job.live`）：child 在任務送出後把 `message_start`／`message_update`／`message_end`／`tool_execution_*` 事件經 `onEvent` 送給 parent（先用成本低的行內字串前置篩選，繼承歷史不轉發，晚到或重複訊息不影響結果）。它只存在記憶體、只在執行中顯示，與第 8 點的落盤 transcript 是兩件事；`complete()`／`finishWithoutChild()` 立即釋放（`releaseLive`），不影響 deliver、transcript 定稿或 permit。

## 儲存

- 原生對話：來源 session 的 sessionDir 內一份 JSONL。
- 查詢 transcript：`<cwd>/.pi/forks/<jobId>/transcript.jsonl`（Fork 開始後才建立目錄；與 metadata 同時被 prune 刪除）。
- Metadata／結果：`<cwd>/.pi/forks/<jobId>.json`（owner-only、原子替換）：role／origin／設定指紋（工具名單雜湊，非內容）／狀態／有界結果／用量／cleanup 證據／delivery 狀態／`transcript`（路徑與狀態）／`blocked` 真相（`reason`、有界錯誤文字、`pending` 計數、`since`）。任務文字只保存 500 字預覽；不保存 credentials。載入只掃描最新 64 筆；受理新 Fork 時，最多刪除 64 筆比這更舊、已終態且不需送達（delivery 非 `pending`）的紀錄，未完成、未送達、無法解析或不屬於本模組格式的檔案一律保留。`blocked.error` 與完成後的 `result.error` 同源、同邊界、同權限，不引入新的敏感資料類別。
- 不寫入使用者全域 settings／auth／排程資料。

## Monitor 觀察（`fork_job`，唯讀）

`session_start` 時在 `modules/monitor` 的 readonly capability rendezvous 上 publish 一個 `fork_job` provider（`src/monitor-capability.ts`，scope = 本 session id + canonical cwd + `state().epoch`），`session_shutdown` 先 revoke 再處理取消。`monitor_start` 傳 `{kind:"fork_job", jobId}` 即可取樣；snapshot 僅有 `jobId`、`status`、`cancelRequested`、`delivery`、`createdAt`（有值才附 `startedAt`／`endedAt`）、`elapsedMs`、可選 `cleanup`／`transcript{state,path≤400字}`／`blocked{reason≤200字,pending,since}`——**不含任務全文、result output、usage 或 native session path**，Fork 結果仍只經 `fork-result` 通知投遞。它不取消、不 resume、不查模型；`awaiting_snapshot`／`blocked` 等非終結狀態會持續取樣，terminal snapshot 送達後才結束。provider 發布失敗（例如 cwd 無法正規化、provider 容量已滿）時，互動 UI 會以警告通知，`fork_job` Monitor 該 session 停用但不影響 Fork 本身。沒有 capability（例如 Monitor 未被選取、managed child、scope 不符）時 `monitor_start` 直接拒絕，`fork_status` 仍是完整細節的來源。

## 部署與限制（CP1 實測）

- 支援拓樸：Pi 1.1.0 CLI＋單一 active `AgentSessionRuntime`，且**每個 session 都載入本管理入口**。目標 session 若不載入本 extension（例如專案 package 設定將其排除），該 session 的 `/reload`／quit 不會取消 Fork；本模組不以 monkey-patch 補洞，也不暗中載入被排除的 extension。
- 裸 `AgentSession.dispose()` 不發 `session_shutdown`，不在支援範圍；強制退出（emergency exit／crash）無法經一般 extension cleanup。child 的 RPC stdin EOF 是最低成本 lifeline：父行程真正結束時 child 自行 shutdown，但不保證強制 kill、停滯 JS 或繼承 pipe 的第三方 descendants 已結束。
- TUI 在回應中或 compaction 時 `/reload` 會被宿主拒絕，不算 reload。
- 取消流程：`abort` RPC → stdin EOF → 等待 `close`（10 秒）→ `SIGTERM`（5 秒）→ `SIGKILL`；Windows 以 `taskkill /T`。仍沒有 `close` 時 `cleanup.childClosed:false`，permit 保留；之後若觀察到真實 `close`，管理器會冪等地歸還 permit 並更新 `cleanup`（`ForkChildHandle.closed`）。**不**宣稱整棵程序樹已停止。
- **`blocked` 已知缺口（未修）**：`blocked` 只負責誠實呈現，**不設放棄期限**。若巢狀工作永不結束，Fork 就停在 `blocked` 並持續持有 permit（每個行程最多 4 個未完成 Fork），需由 `fork_cancel` 收尾。這裡刻意不加 inactivity watchdog：`activeJobCounts` 只有計數、沒有工作進展資訊，無法區分「長時間但正常的工作」與「已卡死的工作」，在此前提下任何固定門檻都可能錯殺合法工作。補上期限需先有可信的工作進展證據。同理，`blocked` 是中場狀態回報（不觸發 `triggerTurn`），不會呼叫 parent 模型。
- Fork 與 parent 共用 workspace：不自動建立 worktree、不合併檔案、不同步 parent 後續訊息；並行寫同一檔案需自行協調。
- 通知使用 `triggerTurn:true`：parent 前景閒置時完成通知會喚醒 parent 一個回合（與 Subagent 背景完成通知一致）。

## 驗證

`npm run test:module -- fork`：strict typecheck、單元（角色矩陣、快照、參數建構、child 狀態機、guard、manager 生命週期、transcript 轉換／寫入／失敗隔離）與真實 Pi 1.1.0 離線整合（快照／獨立 child／回報／A→new→A 只回報來源／quit 取消與 child close／巢狀 background shell 完成前不發布／cold `/resume` 仍拒絕 Fork）。使用隔離 HOME／agentDir／workspace 與本地假 provider，不使用真實 credentials。人工 TUI、真實 provider 與其他 OS 未由這些測試證明。

`blocked` 的回歸矩陣由模擬 provider 提供（模型呼叫在串流中途中斷，不依賴真實額度用盡）：(A) 中途中斷且無巢狀工作 → 仍應快速 `failed`／`CHILD_MODEL_ERROR`；(B) 同 A 加載 pi-runtime → 同結果；(C) 中途中斷加上未完成的長時巢狀 job → 應在模型失敗後立即轉為 `blocked` 並帶 `pending` 計數，**不得**停在無訊息的 `running`；(D) 同 C 但 job 稍後結束 → 應還原並正常以 `failed`／`CHILD_MODEL_ERROR` 收尾，且 `blocked` 不得殘留。A–D 已於專案外隔離 harness 實測通過；repo 內正式測試見 `tests/blocked-report.*`。
