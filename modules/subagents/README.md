# Subagents

提供 `subagent` 工具，將工作委派給獨立的 Pi child process。每個 child 擁有乾淨、隔離的 context window，**看不到主對話**。

## 功能

- 三種建立模式（每次呼叫只能擇一）：single、parallel、chain。後續指示統一使用 `subagent_message`，由系統路由 control／resume。
- 內建 agents、使用者層級與專案層級 agent 定義。
- 所有新派遣自動保存 Pi 原生 session，成功提交後可續接。
- TUI 即時顯示 child 進度（每個 task 保留最新三則單行訊息；工具只顯示 request／completed／failed 與截斷後的參數）。
- 完成後保留完整輸出、sub-session log 路徑與 token／cost 用量。
- 每回合在主代理 system prompt 注入 agent 目錄（名稱、來源、用途）；未信任專案不注入專案層級 agent。

## `subagent` 工具參數

| 參數 | 說明 |
| --- | --- |
| `agent`、`task` | single 模式 |
| `title` | 選填；用 50 字內描述這個 subagent 要做甚麼事，顯示於 TUI，不取代完整 `task` |
| `tasks` | parallel 模式，`[{ agent, task, title?, cwd? }]` |
| `chain` | chain 模式，`[{ agent, task, title?, cwd? }]`；`task` 可用 `{previous}` 取得前一步完整 assistant 文字 |
| `cwd` | single 模式的工作目錄 |
| `background` | 選填布林；預設同步等待。`true` 接受 session-owned 背景工作後回傳 queued receipt；single／parallel／chain 均支援；訊息工具觸發的 resume 一律非同步背景執行 |
| `provider` | 選填；須搭配不含 `/` 的 `model` |
| `model` | 預設省略；只有使用者或 skill 明確指定時才傳入。exact model ID 或 `provider/model`；未知／歧義選擇忽略並使用預設值 |
| `thinkingLevel` | 預設省略；只有使用者或 skill 明確指定時才傳入。`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；未知／目標模型不支援的等級忽略並使用預設值 |
| `agentScope` | `"user"`（預設）、`"project"`、`"both"` |
| `confirmProjectAgents` | 已棄用且被忽略（保留 schema 相容）；模型傳入值不能關閉核准。專案未信任且使用 project 來源 agent 時：有 UI 一律先確認，無 UI 直接拒絕 |

`provider`、`model`、`thinkingLevel` 預設不傳；只有使用者或 skill 明確指定才作為本次所有 subagents 的 override，代理不可自行猜測。`provider` 不可與 `provider/model` 格式的 `model` 併用。`resumable` 參數已移除，傳入會回傳 `INVALID_DISPATCH`。

首次派遣在啟動 child 前，**先解析模型，再檢查該模型支援的思考等級**：

- 模型以 parent registry 的 exact ID 查詢，不做 fuzzy 猜測；明確的 `provider` 僅查詢該 provider。單一模型字串優先採已註冊的 `provider/model` 解讀，否則按完整裸 ID 查詢（優先目前 provider，其餘須唯一匹配）；含 `/` 的裸 ID 若與另一組已註冊的 `provider/model` 衝突，請傳入完整 provider 前綴消除歧義。成功後傳入完整 `provider/model`。未知／歧義 override 忽略，改用已註冊的 agent 模型，否則繼承 parent 模型。
- 未知或模型不支援的思考等級忽略，等同省略 `thinkingLevel`。為允許這種容錯，schema 接受字串，支援清單在執行前驗證。
- 繼承 parent 模型時，預設繼承 parent 思考等級並依宿主能力正規化；使用有效 model override 或 agent 模型、且沒有有效 thinking override 時，不傳 `--thinking`，交由 child Pi 預設設定決定。
- 此容錯只處理新派遣的選擇參數；resume 不接受 override，已保存的模型／信任／checkpoint 驗證保持嚴格。格式錯誤（例如只提供 provider）仍依原規則拒絕。
- Parent registry 的存在／能力檢查不發出模型 API 請求，也不保證 child 能載入相同 provider 或遠端憑證有效。保留 child startup guard；child 設定不一致仍會失敗，不自動重試。

首次 task 須完整說明目標、操作要求、相關路徑、限制／非目標及預期回傳格式。

`title` 是父工具的 UI 標題：single 填頂層欄位，續接填 `subagent_message.title`，parallel／chain 每項可填獨立標題（優先於頂層批次標題 fallback）。Call、執行中及完成後均保留 agent 身份並顯示標題；缺少標題沿用舊呈現。最多 50 個 Unicode 字元（code points／碼點），不按 UTF-16 code units 計數；組合 emoji／重音可包含多個碼點。Schema 保留 maxLength 50，派遣前再次計數，避免宿主分群演算法漏過超長組合文字；另限原始 UTF-8 4 KiB，避免極長 combining sequences。空白、只有控制碼或超長會於派遣前拒絕。沿用 Pi 參數正規化：optional null 可視為省略，數字／布林可轉為字串；直接 execute 收到非字串則拒絕。TUI 清理標題的 ANSI／控制字元與 bidi；不變 task／child args／提示、managed config／guard／trust，不修改真實設定。標題僅保存於 parent 工具 arguments/details；resume 的新標題不改先前紀錄，也不自動沿用前次標題。

```json
{ "agent": "scout", "title": "調查登入與驗證程式碼", "task": "Find all authentication code." }
```

```json
{
  "tasks": [
    { "agent": "scout", "title": "調查模型相關程式碼", "task": "Find model-related code." },
    { "agent": "scout", "title": "調查 provider 相關程式碼", "task": "Find provider-related code." }
  ]
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "Investigate the authentication flow." },
    { "agent": "planner", "task": "Create a plan using this context:\n{previous}" },
    { "agent": "worker", "task": "Implement this plan:\n{previous}" }
  ]
}
```

Task 先寫入權限受限的 UTF-8 暫存檔，不放入 command line。同步模式使用 Pi `@file` 參數；背景模式將檔案內容送入 RPC prompt。兩者 task 內的 `@path` 都不會遞迴展開。暫存目錄建立、prompt/task 寫入及 runner 清理均受 IoGate 取消／期限約束，取消後不再啟動 child；已開始的 OS I/O 不保證能中斷，晚到操作自行在寫入結束後清理其專屬目錄，不提前刪除進行中的寫入。清理故障明確保留 diagnostics。等待 mutation queue 後在實際寫入前再檢查取消。暫存 gate 與 native/transcript gate 分離：pending temp write 不阻止已安全結束的 native writer lock 清理；真正 pending native I/O 仍保留鎖。進入清理時 request 已取消亦啟動 owned deletion，但立即退出等待，晚到刪除由原 owner 收尾。

### 背景工作

每回合注入與 Shell 共用、去重的 `pi_better_tools_background_lifecycle` system prompt section；只有相關建立／管理工具被選取時存在，包含 management-only loadout。通知順序不等於完成順序；partial assistant 結論／log／query snapshot 不是 runner 終結證據，只能宣稱暫定結論。已有充分證據且其餘工作不再需要時，模型須以已選取的 `subagent_cancel({jobId})` 取消 owned 工作（不是 `subagent_message`、也不是 child session ID），再核對收尾；不留著跑只為等通知。仍必要的驗證／寫入／checkpoint／cleanup 不提前中斷。取消要求不等於完整 process tree 已停止，取消／aborted 不得宣稱整套驗證通過。禁止輪詢／sleep 等通知，允許一次性核對終結／取消收尾；cancel 未選取時明說限制，不自行啟用、續接或亂殺行程。此為模型指引，不新增自動取消 heuristic，也不改 registry／guards／followUp／cleanup。

```json
{ "agent": "worker", "task": "完整的委派工作說明", "background": true }
```

- 回傳 `{ jobId, status: "queued", cancelRequested: false, tasks: [{ taskId, agent, status: "queued", logPending: true, subagentSessionId }] }`；每個 item 在回傳前已實際配置 managed session／manifest，ID 不是預造值。jobId 是本次 batch，taskId 是 invocation identity，不是穩定對話 ID。queued／new 身份不代表可互動或 checkpoint ready；未建立 log 不回傳 liveLogPath／finalLogPath。
- 取得 active-child permit 並建立 readable log 後，`subagent_background` custom message（`kind: "log_ready"`，`display:false` 不新增聊天 bubble，模型事件與底部狀態更新保留）提供各 task 的 subagentSessionId／liveLogPath（僅既有 `runs/<taskId>/transcript.jsonl.partial`）。也可用 `subagent_status({ jobId })` 查詢最新資料。Readable log 是 finalized message/tool records，不是逐 token 日誌；可能含敏感資訊。log_ready 另附 `finalLogPath`（rename 後的最終路徑，完成前尚不存在）：liveLogPath 在完成時會被 rename 而失效，之後改讀 finalLogPath／完成通知的 logPath（兩者相同）；完成後 status 不再回傳 liveLogPath／finalLogPath。依完成通知的 logPath 重新讀取，aggregate log 不沿用 run-local offset。
- 完整 runner 完成（包括 native identity／guard／digest、commit/rollback、writer release）後，送出 `kind: "task_result"` custom message，加上 `{ triggerTurn: true, deliverAs: "followUp" }`；主 agent 忙碌時排後續，閒置時觸發回合。原始輸出是委派內容，不提升為 system 權限。每 task 通知摘要取當次 invocation 最後有效 terminal assistant 文字的首個非空行，最多 512 UTF-8 bytes；於 2 MiB aggregate／8 KiB background head cap 前保留 bounded 內部候選，新 assistant／tool／retry start／agent_start 使舊候選失效；Pi 1.0.0 的成功 auto_retry_end 在 recovered message_end 之後，屬完成 recovery 的觀測，不清除新的有效候選，runner settlement 與權威 status 後才發布。沒有有效 terminal 文字不將早期 progress 當結論；failed／aborted 摘要保留診斷。status 的完整 receipt 仍保留最多 8 KiB aggregate head，完整 readable 輸出見 result.logPath；不新增公開 result 欄位或 managed 儲存格式，chain `{previous}`／usage 不變。
- `subagent_status({})`（省略 jobId）唯讀列出同 owner session／cwd 的 jobs：`{ jobs: [{ jobId, status, cancelRequested, tasks: [{ taskId, agent, status, canMessage?, summary? }] }] }`，summary 為同一 terminal 摘要（最多 200 bytes）；已知 canMessage／cancelRequested 的 false／true 明確保留，undefined 不推成 false。背景派發後不要輪詢，等待 `task_result` followUp。
- 容量錯誤（`BACKGROUND_CAPACITY`、`Too many parallel tasks`）會附目前 `submitted n/32, active n/8` 與建議動作（subagent_status、subagent_cancel、拆批）；32 submitted／8 active 上限不變。
- `subagent_status({ jobId })` 回傳當前 receipt 與 bounded task result（status、exitCode、usage、canResume、logPath、摘要）；`subagent_cancel({ jobId })` 要求取消，回傳 cancelRequested。取消不是確認完整 process tree 已退出，請查詢最終狀態。管理工具限相同 owner session/canonical cwd/runtime；不重複加入 tool usage。
- 背景 usage 在 status/通知呈現，**不自動加入 host totals**。Job registry 僅存在目前 runtime，最多保留 64 jobs，超量時移除最舊的已結束 job；managed native/log/run metadata 仍在磁碟，不自動刪除。退出後不能用 jobId 恢復工作，不保證通知 exactly-once 或送達確認。內部 payload-free 觀測最多保留 128 筆／省略數，區分 canonical applied、callback attempted／returned／threw 及 owner/generation suppressed；可注入 observer 的例外不影響 lifecycle，不記 prompt／output／interaction payload，不新增工具、設定或 durable queue。callback returned 不是 host queued／persisted ack，API 無 ack 時仍為 unknown；隔離 Pi 1.1.0 SDK 測試另觀察實際 streaming followUp queue／idle persistence／host async error，不自動重送或更改 followUp／triggerTurn。
- 接受前尊重 tool signal；接受後改由 job-owned signal 控制，因此原 turn 結束不會偷偷取消工作。退出、reload、session replacement 會抑制舊 generation 通知、取消 jobs，最多等待 15 秒 cleanup；既有 child kill escalation 與 bounded I/O 保留。未及清理或強制退出仍可能留下 process tree／blocked writer。
- Process-wide 背景 submitted task 總量上限 32（包含 running/queued，取消直到清理完成才釋放容量），仍共用既有 8 active-child permits。Chain 每個 step 在受理前都有實際 managed session；未開始 step 誠實保持 new／logPending，失敗後標示 skipped，不建立假 log 或宣稱 ready。配置失败／受理前取消會釋放 admission，已配置但未執行的 session 保持 new（無 checkpoint，不能續接）。
- 背景與主線共用 workspace，避免同時修改同一檔案；需要時自行使用獨立 worktree，不自動 Git 同步。
- 同步模式沿用 JSON print；背景模式使用 RPC prompt／steer／get_state／get_entries。RPC 無 session header，改由 startup guard、get_state 的 native path／ID／model／thinking 與 canonical startup entries 驗證；保留 managed lock／wire-native digest／checkpoint，不使用會覆寫信任參數的 RpcClient。`agent_settled` 後停止互動，待已接受 query 的獨立期限結束，再關 stdin orderly shutdown；child 確實退出後才提交。

背景互動驗證基準為 Pi 1.1.0（唯一支援版本）。不支援 canonical inMemory entries/leaf replay 的 host 會拒絕 query，不降級使用空白或猜測的 context。

### Session 載入時核對背景工作

版本化 `pi-better-tools-background-state` journal 保存 job/task/child session IDs、owner/canonical cwd/runtime、task/batch 狀態、exit/error code 及 shutdown reason；不保存 prompt/output/control/query/credentials，不新增 durable execution queue。queued intent 在 managed allocation 前寫入，配置完成再補真實 child IDs；配置失敗保留未開始的 intent／failure 證據，但不送 acceptance/task_result 通知。受理 journal I/O 失敗先拒絕，容量會釋放，沒有 child runner；後續記錄故障不改真實結果。Pi 1.0.0 的空 SDK session／`--no-session` 無法保證 journal 落盤，因此背景 create／resume admission 會以 `BACKGROUND_JOURNAL_FAILED` 拒絕；同步 create 與 live control/query 不因此改變。

startup/resume/reload 時 bounded 核對同 owner/cwd 的 session-wide inventory，在 active branch 發 `background-runtime-recovery-subagent` custom 訊息（display:true、triggerTurn:false）。沒有相關歷史不發，已保存相同證據／正常完成通知去重，新證據可補；跨 branch 需要新的 context 通知，fork 不採用無 owner 的 legacy receipt。finding 分為已記錄終結結果、shutdown cancellation requested、outcome unknown、start not confirmed，不把 queued 身份當成 ready／可互動，processTreeState 仍 unknown。通知英文前言＋compact JSON，TUI 收合顯示數量／ID 尾碼／finding，展開完整 IDs、task/child 身份、outcome、reason、next action。

共用 Shell `src/recovery.ts` 的純解析／呈現 helper，不共用執行 registry；100,000 entries、4 MiB 整體解析預算、32 KiB 單筆文字、128 jobs、每則 32 findings，上限／malformed 明示 incomplete／omitted。只讀 Pi journal，不掃 child native、lock 或 checkpoint，不呼叫 acquire/rollback/resume、重送 control、重啟 child 或模型。不是 exactly-once／host ack，也不確認整棵 process tree 死亡；legacy fallback 不保證重建全部舊工作，退出後不能用舊 job ID 復活工作。

### `subagent_message`：統一指示／唯讀 query

```json
{ "subagentSessionId": "<完整 session ID>", "message": "完成目前工具後，先回報結果，不再修改檔案。", "title": "回報目前成果" }
```

```json
{ "subagentSessionId": "<完整 session ID>", "mode": "query", "message": "依目前可見的快照，哪些步驟已完成？" }
```

- 必填 `subagentSessionId`、`message`；選填 `mode:"control"|"query"`（省略為 control）與顯示用 `title`。只接受完整穩定 session ID、相同 owner session／canonical cwd／runtime，不接受舊 jobId+taskId 定址。訊息限非空白、64 KiB UTF-8；title 沿用 50 Unicode 碼點／4 KiB 驗證，不改保存配置。
- Control 依**當前** registry／managed checkpoint／ownership 證據路由：running interactive → control；沒有活動 invocation 且安全 ready → 嚴格驗證後非同步背景 resume。parent 不必依舊 `canMessage`／`canResume` 快照選工具。queued、startup、finalizing、canceling、busy 明確拒絕，沒有跨 invocation 等待佇列；blocked、startup failure、owner／cwd／config／trust／model／checkpoint 不符不能偷偷新建。
- 成功 receipt 是 `{ subagentSessionId, mode, action:"control"|"resume"|"query", status:"accepted", jobId, taskId, messageId?, queryId?, background? }`；control 有 messageId，query 有 queryId，resume 有新 jobId/taskId 與完整 background receipt、ID 不變。**accepted 不是工作完成**；resume 完成以新 invocation 的 task_result followUp 通知，沒有主工具 usage 重複入帳。title 只顯示當次工具呼叫／新背景 invocation，不沿用或改寫歷史。
- 拒絕 receipt 是 `{ subagentSessionId, mode, status:"rejected", errorCode, observedState, nextAction, error }`；所有拒絕均保留模型端 `isError:true`；預期的 busy/not-running/capacity/cancelled 僅改為 warning 文字，其他安全／設定／checkpoint／未知故障維持 error 呈現，原生工具背景由 Pi 控制。`status:"rejected"` 始終表示訊息未送達，不是 accepted／成功；無安全狀態時 observedState 明說 unknown，未採用路徑時不回 action，也不回假 messageId/queryId/jobId/taskId。缺少操作欄位不是 false 的替代，receipt 模型文字保留 cancelRequested／canMessage／logPending／已知 canResume 的 false。
- Resume/query preflight 先以唯讀 resolve 授權 owner/cwd，才檢查 shared contention，避免外 owner 的 reservation 被誤判為普通 busy；保留 process-wide session invocation admission 後再 resolve 並驗證完整 checkpoint/config。active-session lookup 直接拒絕 owner/cwd/runtime 不符，不繞回 ready 路徑；另一則 concurrent ready 訊息拒絕 SESSION_BUSY，不能啟動第二個 child。runner 取得既有磁碟 writer lock 後重新驗證 checkpoint／saved configuration，child guard 再驗證實際配置。接受前尊重 tool signal，接受後由 job-owned signal 管理。已接受的 control 即使隨後 settled 或 delivery_unknown 也**不重送**成 resume。
- Query 支援 running interactive invocation **及已結束的 ready managed session**；兩者均不續接主線。ready query 先驗證同 owner/cwd、agent/config/trust/model 與完整 checkpoint，取得既有 writer fence 的獨占讀取租約，**不接管 stale writer、不 rollback、不新增原對話 run**。原 native／manifest／readable transcript 保持逐 byte 不變；同一 session 在租約期間的 control／另一 query 立即拒絕 SESSION_BUSY，沒有等待佇列。
- **Control 是永久委派 user input**：使用 `[Delegated user control <messageId>]` 歸屬前綴，再原樣附上文字。前綴讓 slash／skill／template 不是第一個字元；RPC 不解析 `@file` prompt arguments。FIFO 以 one-at-a-time steering，在 assistant + tools 回合邊界消費，不中斷長工具。回傳 `{ messageId, status: "accepted" }`；status 的 `queued` 只表示 child ack，不是 applied。只有 exact canonical user message event 才回報 `applied`（含 timestamp／userOrdinal）並 followUp 通知 parent；只有未送出或 input hook 明確回覆 `handled`（未進 canonical 主線）才標 `not_applied`。合法 input hook 可能 transform 文字與前綴；已送出但無法 exact correlation，即使 ack 為 queued 或 task 已 settled，也標 `delivery_unknown`，不可據此自動重送。未 transform 時原文字與前綴同時進入 wire/native 主線；transform 後 canonical 文字仍遵循既有 managed digest 驗證。
- **Query 是一次性、唯讀模型請求**：回 `{ queryId, status: "accepted" }`，答案以 `kind:"query_result"` custom followUp 回 parent，放在 `interaction` 欄位。live query 沿用原 jobId／taskId；ready query 有獨立的背景 jobId／taskId（供 status/cancel），但 subagentSessionId 不變，tasks 標 `readOnlyQuery:true`、`canMessage:false`、`logPending:false`，不偽造新 subsession log。ready query 僅在持久化父對話受理；與一般背景工作共用32 submitted／8 active-child／64 retained jobs與關閉保障。Child bridge 經獨立、token-bound IPC 回覆，不 print stdout、不提交主線 prompt、不 fork 原 session。使用 child 自己的 verified provider／model／thinking／trust 和 modelRegistry；不可用時失敗，沒有 parent model fallback，也不複製 credentials。
- ready query 在租約下捕捉有界、hash 驗證的 committed native bytes，開啟**私人暫存工作副本**讓 child 自己載入 provider/registry/trust；不傳送 task prompt／steer。同一既有 argument builder／startup guard／token-bound query bridge 保留所有遞迴工具 exclusions，worker 再設 `--no-tools`。模型請求 replay 另一份 hash 驗證的 frozen checkpoint copy，不採納 startup hooks 對工作副本的變更，也不恢復被原生 compaction/context edit 移出的上下文。正常 query_result 在 child 真正 close、暫存清理與原租約釋放後送出；不另發 log_ready／task_result 冒充原任務重新完成。這是 process isolation，不是OS sandbox；query仍有獨立模型成本。
- 即使模型已回答案，後續已確認的協定／禁止主線事件仍使 ready query **failed**，移除成功答案但保留已知 usage/asOf。已知故障先發 `cleanupPending:true` 診斷，不等待無法確認的 close/I/O，也不提前釋放所有權；晚到清理證據以同一 queryId 校正，不復活答案。`cleanupEvidence` 分別記錄 childClosed、ioSettled、temporaryRemoved、originalLeaseReleased；暫存刪除或原租約釋放失敗不以 runner 結束假稱已清理。`cleanupPending` 可能表示殘留檔案／未確認的租約，而非模型 API 仍在執行；依各證據判讀。
- stdout EOF 尾段即使沒有換行也必須經協定檢查，不能因 child 正常退出而忽略壞 JSON 或禁止主線事件。清理等待期間，status 以 worker 故障診斷優先於 RPC 的模型 terminal snapshot；尚未整體結束的成功答案不提前公開，原租約尚未確認釋放時保留 `cleanupPending:true`，不公開可能殘留 completed／清理成功欄位的私人 worker result。握手後及 query IPC 送出前同步檢查既有 fault／shutdown／gate／owner abort，協定故障不能因先收到合法握手回覆而啟動模型請求。
- live Snapshot 直接讀 child SessionManager 的 canonical entries/header，驗證單一 chain／leaf，取最近完整配對 assistant-tool batch 的 prefix；用隔離 inMemory SessionManager 重建 system／compaction／context_edit。保留 opaque provider metadata（包含 thinking signatures），清除每個 system checkpoint 的 toolsAdded/toolsRemoved；不呼叫主線 hooks、不提供可執行 tools。收到第一個 toolcall_start／toolcall_delta／toolcall_end 串流事件即 abort，回報 `QUERY_TOOLS_FORBIDDEN`，不等工具參數完成，也絕不 dispatch tool；仍 drain 到 provider terminal evidence 才回覆，不虛構未回傳的 usage。
- 長工具進行時 query 可能只看見前一個安全 prefix。`asOf` 回報 safe entryId／timestamp、sourceLeafId／capturedAt、sourceTurn 的 user／assistant ordinal、stale、pending tool count/IDs 及已進主線 control IDs；metadata ID 列表有截斷標記。不宣稱工具的未見副作用已完成。超過 8 MiB／16,384 entries、branch／leaf 不一致或 replay 後 tool pairing 不安全時拒絕 query，不修補或默默 fork。
- Query 不改原 native leaf／checkpoint／主線 wire digest，也不把問題、答案或 usage 寫入 child 的 readable/native 主線。獨立 `usage` 保存在 status／query 通知，**不加入主線或 host totals**；中途 transport 關閉或無 provider terminal usage 時標 `usageUnknown:true`，不是假零用量。Query 失敗不終止主工作，也不重置其 inactivity timer。逾期回報的 `cleanupPending:true` 不代表 API 已停止，並行租約仍保留至 terminal IPC／實際 child close；runner abandon、receipt 結束、關 stdin 或提出 kill 要求都不算資源已釋放；晚到 terminal usage 以同一 queryId + `lateUsage:true` 校正，絕不復活逾期答案或重複累加通知用量。
- Runner 已移除 child handle 後，晚到 terminal／實際 close 仍更新同一 job/generation 的 retained query receipt（含 `cleanupPending`），避免過期狀態錯誤占滿 sibling query 容量；不復活 aborted 答案、不重複通知既有用量，舊 generation 不更新新工作。
- 每 invocation 最多 32 controls；query 同一 job 最多 2 concurrent／32 retained，process-wide 最多 8 concurrent，每 task 也限 2／32。每 query 最多 30 秒、2048 requested output tokens、64 KiB streamed output，parent answer 保留 8 KiB（IPC reply envelope 128 KiB，容納 JSON escaping／bounded metadata）；opaque provider 回應與取消仍依 provider 是否尊重 signal。RPC commands 最多 16 outstanding／8 MiB queued bytes，30 秒 response deadline；stdin 用 callback backpressure，關閉最長再等 5 秒。
- 取消會先傳 query abort 與 orderly RPC EOF（最多 1 秒 shutdown grace），再保留既有 kill escalation；退出／reload／session replacement 同樣 abort API signal 並抑制舊 generation 通知。這是 bounded best-effort cleanup，不保證停止遠端/provider 工作或整棵 process tree。job registry 中已結束 tasks 只保留 plain receipts；尚未確認關閉的 child 仍由事件 listener 保留 query 租約，直到 terminal reply／實際 close。
- SDK 嵌入必須使用 `await runtime.dispose()`（AgentSessionRuntime）觸發 extension shutdown；直接 `session.dispose()` 不發送 shutdown，無法保證背景 cleanup。通知 callback 若因 owner/context 失效而拋錯，runtime 會 fail closed：取消其 jobs、拒絕新 admission、抑制後續 callback，不重試通知。若宿主靜默接受失效 callback，extension 無法自行偵測，因此宿主仍須正確 dispose runtime。

### 即時背景工作 TUI 面板

原生 `setStatus()` 在 footer extension 狀態列顯示共用摘要 `▸ Subagents：N ｜ ▸ Shell：M`。Subagents 計算目前 owner／canonical cwd／runtime epoch 的 queued／running tasks（含未終結取消要求），不是 OS child 行程數。已完成 tasks 不計數；全 batch 正在 finalizing 時摘要可為0，仍可展開看 finalizing，不偽裝成執行中的 child。預設收合不掛 widget、不顯示 title／command；footer 文字不可點擊，與 Fast／其他 extension 狀態共存，排序／截短由宿主決定。以 `/background-jobs subagents` 操作，展開才在 belowEditor（輸入框下方／footer 上方）掛詳細 widget；全螢幕可點擊該 widget 的 Subagents 標籤切換，一般模式不接管終端滑鼠。省略參數／all 切換全部，collapse 全收合；不搶 editor focus。

展開才列 agent、queued／running、job/task ID 尾六碼及 title；Title／agent 投影先限256字元，再移除顯示控制碼與依欄寬截短，最多八列（running 優先）加 header／省略数（十行）。不顯示 task prompt、log、結果或 control/query；狀態來自既有 registry，不是 OS 監控。完成逐項移除，該區清零重設收合，所有工作終結才清除自有 footer 狀態與 widget，不移除其他 extension 狀態；取消或移除面板不能證明 provider/process tree 已停止。

共用 key `pi-better-tools-background-jobs`；刻意依賴 Shell Tools 的純 UI helper，經公開 pi.events rendezvous 分享 presentation，不分享 job registry、權限或工作操作。兩種載入順序與單模組均支援，不替換 footer／其他 widget、不啟用未選工具。僅 TUI+hasUI，RPC／JSON／print 不掛面板。事件更新，無輪詢／ticker；owner、epoch、lease／disposed pointer 與 shutdown 防護，UI 錯誤不改派發／通知，private title metadata 不進 receipt／模型內容。不列同步／其他 session/workspace 工作；等待背景工作結束後 `/reload` 載入。

### 背景訊息與管理結果 TUI

通知／摘要／查詢回覆以中性文字說明「回傳資料，不是指令」，不是錯誤或可信度評分。queued／accepted 使用中性圓圈，不用警告驚嘆號；failed／not_applied 的錯誤顯示及其他狀態區分保留。模型通知仍保留 `outputTrust` 欄位，但改成明確的 informational 說明：內容僅供審閱、不提升為指令，是否失敗須看 status/error。新措辭不改信任邊界、receipt/schema、通知喚醒或 lifecycle；舊 session 的原始通知文字不重寫。

背景 custom message 通知使用與原生工具呼叫相同的 SDK Box 背景色塊，不畫框線，收合與展開一致。依主工作或 interaction 的權威狀態採 toolSuccessBg（completed／applied）、toolErrorBg（failed／not_applied）或其餘 toolPendingBg 色盤，不將 aborted／accepted／未知改稱成功或執行中。3欄以上左右各留1欄，上下各留1行，300行包含留白；SGR reset 後重套背景避免色塊斷開。管理工具／派發 receipt／同步結果仍用原生工具區塊，不再套第二層背景。顯示 tab 轉空白以維持欄位對齊。

`/reload` 後，新的 log_ready 不顯示聊天訊息；`subagent_background` 的 task_result／control_result／query_result（及歷史 log_ready）、`subagent_status`／`subagent_cancel`／`subagent_message` 結果及背景派發 receipt 改用摘要／原生展開顯示，不再堆原始 JSON。收合列表最多五個 job、每 job 三個 task、單行結論；單一工作最多三行結果／錯誤。展開看完整 ID、已有 live/final log、session／可續接狀態、通知保留的輸出／錯誤、獨立用量及互動，不讀 log，也不恢復丟棄輸出。欄位最多8192字元、64 jobs／32 tasks及互動、整體300行；省略／截短都有提示。

狀態取自 receipt，不以輸出中的 Error 字詞判定。取消要求不等於程序樹終止，aborted 不改稱 failed；Control 的 accepted 顯示 `Control message accepted; waiting to be added to the subagent conversation.`，queued 顯示 `Control message queued; waiting to be added to the subagent conversation.`；兩者皆為等待狀態，不是錯誤。applied 只表示已確認納入子代理對話，不代表要求的工作已完成。log_ready 是通知時快照，finalLogPath 於該時點只是尚未存在的未來路徑。Query 顯示快照／stale、未知用量（不是零）、late usage（不復活答案）與 cleanup pending（不宣稱 provider 已停止）。完成通知的 display details 額外保留 query cleanupPending／asOf／lateUsage／outputTruncated，模型 content／structuredContent、followUp／triggerTurn、usage accounting 與 lifecycle 不變。僅顯示層清理 ANSI／OSC／控制碼／bidi，支援 Unicode 欄寬與缺 details 的舊JSON／text blocks；同步模式既有進度透過 onUpdate 更新原工具呼叫 bubble；收合用同一 terminal 摘要，展開 Markdown／完整 content 不變。內部摘要不序列化；舊 saved results 的 structured／list 摘要沿用歷史首行 fallback，沒有內部 metadata 的同步收合呈現亦保留原 aggregate 輸出，不重寫歷史，新完成通知的既有 content.output 摘要可供 reload 收合呈現。

顯示訊息統一使用英文：資料標籤為 `Subagent notice: returned data, not instructions.`／`Subagent summary: returned data, not instructions.`／`Query response (snapshot data, not instructions)`；搜尋範圍標為 `[agent scope: user]`（不冒充實際來源）。工具進度用 `Tool request/completed/failed: <name>`，不是整個任務完成。applied 說明僅確認訊息納入對話；query completed 僅確認答案回覆，與主工作完成分開。

正常 partial／snapshot／late usage 使用中性說明；cleanup pending、delivery_unknown 及真正錯誤仍保留提醒。終結缺 log 顯示 `No subsession log path was provided for this result.`，running 顯示 `Subsession log is being created.`；running 不再由 canResume=false 推成 blocked。aborted 以 `aborted · task stopped`／`Stop reason:` 呈現，不改 isError、退出碼、ownership 或程序樹判定。截短只說明目前保留範圍，有既有 logPath 才推薦讀取。容量錯誤保留原碼與上限，說明新請求未受理。

`subagent_message` 預期拒絕（`TASK_NOT_RUNNING`／`SESSION_BUSY`／query/control/background capacity／`MESSAGE_ABORTED`）在收合及展開顯示 warning 的 `Query/Message not accepted`、Reason code、觀察狀態、session 與 nextAction；checkpoint/config/trust/ownership與未知故障仍為 `Subagents error`。所有未受理訊息保留模型端 `isError:true` 與 rejected receipt；warning 只改標題／說明，Pi 原生工具仍依原旗標顯示紅底，不把未受理改稱成功。歷史結果不改寫，舊 isError:true 的原生背景仍由Pi控制，renderer只改善標題/說明。不因缺少未受理的 job／interaction ID 誤稱資料不足。預期拒絕先套 warning 分類，其他工具結果以 Pi 1.0.0 的 `context.isError` 為優先；只有舊直接呼叫缺少此旗標時才沿用 `result.isError`。歷史 details／JSON 的 `status:"rejected"` 亦可辨識；不改寫原始模型內容，不自動重送或放寬訊息受理條件。

### RPC 啟動失敗診斷

RPC 啟動錯誤保留原始錯誤碼／訊息，另附英文 `Startup observations (before cleanup)` 與 `Cleanup observations`，避免把要求終止後的 exit code 誤當原始啟動原因。觀察包括目前 parent 階段／最後完成 checkpoint、monotonic 相對毫秒、spawn／child close、stdout／stderr byte counts、extension UI request／不匹配 RPC response 數量，以及 bounded timeline（最多24筆，附省略數）。各階段區分 get_state、native/model identity、startup guard 檔案驗證、canonical entries、steering 與 initial prompt；`Initial task prompt requested` 只表示 parent 已呼叫 prompt，不代表 child 接受或模型工作完成。

- `Stdin write completion observed` 只是 Node Writable callback 成功，不證明 child 已讀取；`matching RPC response observed` 只計匹配 id／command 的合法成功或拒絕回覆。不匹配 ID 不存原始 ID／內容。
- RPC child guard 經既有 token-bound IPC 報告 loaded／session_start／verified／rejected／failed 少量里程碑與 child SDK 的 Pi／Node 版本；缺少回報時版本為 `unknown`，不冒充 parent 版本。Parent 僅接受固定 channel/token、enum／錯誤碼／版本字串 allowlist，重複與額外欄位忽略。IPC 回報只是診斷，不代替 on-disk guard、trust／model／native identity／checkpoint 驗證。
- CLI 記錄只保留 executable 與可辨識的第一個 JS/TS script path（各最多512字元）；不記整份 argv／environment／IPC token／RPC params／回覆 payload。新增觀察不讀 credentials；原有 stderr 與 opt-in debug input 仍可能敏感，分享前自行檢查。
- 未收到里程碑一律說 `not observed`，不斷言 guard 沒有執行；guard verified 也不證明其他 session_start hooks 或 RPC loop 已 ready。確切原因未知時明說 `Exact cause is unknown`，只提示對應階段、設定／startup-file／IPC／互動初始化檢查，不指認未觀察到的 extension 卡住。
- 30秒 RPC response budget 仍包含 startup／queue time；不調整期限、不新增 timer／重試、不改權威狀態或鎖清理。`child close observed` 不等於整棵 process tree 已終止。
- 核心診斷在 errorMessage，即使 debugLog 關閉仍可看見；原有 managed run `diagnostic`／debug JSON v1 `errorMessage` 保存同一文字與內嵌 `Startup observation data` JSON，不新增 public result/schema 或 managed 格式欄位。Debug 仍 failure-only／opt-in，舊紀錄不改写。

### 上限

- parallel 最多提交 32 個 task、chain 最多 32 個 step；超量請求在確認提示與 log 建立前即回傳錯誤。
- 同時執行的 child 上限 8 個，為整個 Pi process 共用（同一 turn 的多個並行 `subagent` 呼叫合計不超過 8 個，多的排隊；排隊中被取消者不會啟動 child）。
- Child 連續 300 秒沒有主工作 stdout activity 即因 inactivity timeout 失敗；JSON 模式以 stdout bytes 計，RPC 僅接受主線事件，correlated responses／query IPC 不重置。stderr 輸出也會重置，但只在最後一次主 stdout activity 後 4 倍期限內有效，避免只吐 stderr 的 child 永遠不逾時。
- `agent_settled` 後 JSON child 若五秒內未結束，會被終止並保留已完成的結果；RPC 先結束已接受 query 的獨立期限、orderly 關 stdin，之後同樣有五秒退出 grace（不以 query 活動延長主線 inactivity）。
- 取消或 timeout 在 POSIX 對 child 自有 process group 送 SIGTERM，五秒後仍未結束則 SIGKILL（group signal 失敗時回退 direct child）；Windows 以 best-effort `taskkill /T /F /PID` 加 direct child signal 嘗試終止子行程樹。以上皆不保證清除完整 process tree（終止要求不等於 process tree 已停止），不自動重試。若 SIGKILL 後 child 仍未結束，結果會誠實標註它可能仍在執行，停止讀取管道，但保留 active-child permit 與 writer lock 至實際 close；若另有 pending native/transcript I/O，lock 也須等所有實際 I/O、spool iterator return 與 writer close 完成才釋放。晚到收尾只發布 blocked，不把失敗 receipt 改為 ready；永久卡住或收尾失敗仍保留鎖與診斷。`Ctrl+C` 會中止 child。
- Child 非零結束且未產生 startup handshake 時，錯誤訊息附上 stderr 尾端，不再只顯示 ENOENT。
- Child 以 `PI_SUBAGENTS_GUARD` 接收啟動 handshake，guard 讀取後即從環境刪除，孫行程不會繼承。
- Pi CLI 解析順序：環境變數 `PI_SUBAGENTS_PI_CLI`（指向 `cli.js` 或可執行檔）、宿主提供的 `@earendil-works/pi-coding-agent` bin、`process.argv[1]`、PATH 上的 `pi`。以 SDK 內嵌時不會再重跑宿主應用程式。
- stdout 單筆 JSON record 上限 8 MiB；stderr diagnostics 上限 512 KiB；retained assistant 輸出預算 2 MiB；tool alias／key 帳目另限 8 MiB，不挪用輸出預算。累積 assistant 輸出超過預算時截斷並附註，不會讓成功的 run 失敗。
- Log 寫入 I/O 另有 300 秒停滯期限。
- Writer 的實際 `FileHandle.close()` 成功才是 ownership release barrier；關閉拒絕時保留原始失敗原因與明確的 `Writer close failed` 診斷，不 rename、不 commit、不 rollback／發布 ready，也不釋放 managed writer lock。`finalize()` 仍回傳 structured log error；`abandon()` 保持 rejecting barrier，立即附拒絕 handler，即使 pending I/O 令 runner 暫時無法 await，亦不產生未處理 rejection。晚到 writer 建立／finalization 同樣遵循此規則；成功關閉與正常／晚到清理仍可釋放鎖。關閉失敗不自動 retry，磁碟 manifest 可能仍為 running／committing，但 live writer lock 仍禁止續接；故障後須確認實際資源已終止，不能因 receipt 已結束就手動刪鎖。Runner 測試 helper 現在以 owned settlement barrier 等待 actual child／I/O／late managed release／prompt cleanup，再拆自己的 root；初始化取消測試以 owner.json write event barrier 交錯，不靠固定 sleep 或 rm retries。已重現 helper teardown 重疊不等於確認所有歷史 EPERM／ENOTEMPTY 根因，也未確認產品 premature ownership release；歷史項目仍 open。

## 續接

派遣成功並完成驗證後，結果會回傳 `subagentSessionId` 與 `canResume: true`：

```json
{ "subagentSessionId": "<subagentSessionId>", "title": "實作並驗證方案 B", "message": "採用方案 B，繼續實作並執行驗證。" }
```

- 透過 `subagent_message` 送出非空 `message` 與選填顯示用 `title`；不接受 agent、tasks、chain、cwd、provider、model、thinkingLevel、agentScope、confirmProjectAgents、background。續接一律為非同步 background invocation。
- **遷移**：`subagent({resume,...})` 公開操作已移除，直接 execute 回 INVALID_DISPATCH 與新訊息介面指引，不啟動 child、不轉成 create。舊 `subagent_message({jobId,taskId,...})` 缺穩定 session ID 時拒絕並提示遷移。保留內部 ManagedSession／runSingleAgent continuation primitives；舊 session、通知與 tool-call renderer 照舊可讀，不改寫歷史。
- 新 ID 使用 `ulid().toUpperCase()` 產生完整大寫 ULID；仍接受既有完整小寫 ULID／舊版小寫 UUID，不轉換保存的 ID 大小寫；續接只載入該 child 自己的歷史，看不到 parent 新對話。
- Parallel／chain 每個 item／step 各有獨立 session，不共用 context。
- 限相同 parent session 與 canonical parent cwd。
- 保存 agent 定義、cwd、model、thinking 與 trust；agent 被修改／移除、cwd 或 model 不可用、信任改變時拒絕。
- 只有 ready 的 session 可續接；busy、blocked 的不會被接管。
- 先前 ready 的 session 續接時若 run 失敗、取消或逾時（child 已確實結束，且非 checkpoint／commit／startup 驗證類失敗），會在 checkpoint 的 native hash 前綴仍相符時，把 native 檔與 readable transcript 截回 checkpoint 位元組並還原為 ready；前綴不符則維持 blocked。首次 run 失敗仍為 blocked。
- Parent crash 遺留的 `writer.lock`：僅當 owner.json 記錄的 pid 已不存在，或同 pid 的 nonce 未在 process-wide live-owner registry 登記，且有已驗證的 checkpoint 時，才會接管並依上述規則回復；已登記的 live owner（包含 reload 前與晚到 I/O）或無法驗證時維持 SESSION_BUSY／SESSION_BLOCKED，不自動接管。pid 可能被作業系統重用，此為 best-effort 判斷。
- 錯誤碼：`INVALID_DISPATCH`、`SESSION_NOT_FOUND`、`OWNER_MISMATCH`、`SESSION_BUSY`、`SESSION_BLOCKED`、`DUPLICATE_DISPATCH`、`METADATA_UNSUPPORTED`、`CHECKPOINT_MISMATCH`、`CONFIG_CHANGED`、`CWD_UNAVAILABLE`、`MODEL_UNAVAILABLE`、`TRUST_REQUIRED`、`COMMIT_FAILED`。
- 不保證副作用 exactly-once。

若需要決策，child 應回報選項後正常結束，不要常駐等待。

## 內建 agents

| Agent | tools | 用途 |
| --- | --- | --- |
| `scout` | read, grep, find, ls, bash | 快速探索程式碼並產生可交接的精簡 context |
| `planner` | read, grep, find, ls | 依需求與 context 產生實作計畫（唯讀） |
| `reviewer` | read, grep, find, ls, bash, note | 品質、安全與可維護性 review；bash 僅限唯讀，完整報告唯一透過 `note({ type: "report", content })` 新增 |
| `worker` | 不限定 | 通用、完整能力；僅在使用者或 skill 指派時啟動 |

內建 agents 不固定模型，繼承主 session。

Reviewer 不提供 `write`／`edit`，不修改被審查的程式或設定，亦不得用 bash 保存報告。完整審查內容由原生 `note` 自動命名並新增至 `report/`；成功後只回一句結論與實際相對路徑（150 words 以下）。若 note 未載入或寫入失敗，回報 blocked 與原因，不換其他寫檔方式、不虛構路徑。這是 agent 操作契約，不是 OS sandbox；使用者／受信任專案的同名自訂 reviewer 仍可依既有優先序覆蓋 bundled 定義，需自行同步其工具與報告契約。

## 自訂 agents

Markdown 檔，位置：

- 使用者層級：`~/.pi/agent/agents/*.md`（遵循 `PI_CODING_AGENT_DIR`）
- 專案層級：從 cwd 向上找到最近的 `.pi/agents/`

優先順序：專案 > 使用者 > 內建（同名覆寫）。`agentScope` 預設 `"user"`，需指定 `"both"` 或 `"project"` 才會使用專案 agents。

未信任專案的 project-local agent 需 `confirm` 批准：dialog 會收到工具的 AbortSignal，取消工具時關閉；取消後（含晚到的批准）不派遣 child。`provider`／`model` 組合無效（空白 provider、provider 缺 model、provider 加 provider/model）回 `isError:true`，且不派遣。ready-query child 的 `before_agent_start` throw 只是回報，宿主 catch 後會繼續該 turn，**不是 admission barrier**；實際防護是 child 的 `--no-tools`／`--exclude-tools subagent` 與 guard（契約測試 `tests/approval-and-ready-query.integration.test.mjs`）。

Frontmatter：`name`、`description`（必填，皆須為字串）、`tools`（逗號字串或陣列）、`model`（選填）；本文為 system prompt。格式錯誤的檔案會被略過。

```markdown
---
name: test-writer
description: Designs and implements focused tests
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
---

You write focused, reliable tests. Inspect the existing test conventions first.
```

## Prompt 指令

| 指令 | 流程 |
| --- | --- |
| `/implement <需求>` | scout → planner → worker |
| `/scout-and-plan <需求>` | scout → planner（不實作） |
| `/implement-and-review <需求>` | worker → reviewer → worker 套用回饋 |

## Sub-session 儲存

位於 `<agentDir>/subagent-sessions/<subagentSessionId>/`（預設 `~/.pi/agent`）：

```text
manifest.json         # owner、配置、狀態、checkpoint
pi/*.jsonl            # Pi 原生 session
transcript.jsonl      # 查閱 log（user／assistant／tool_call／tool_result）
runs/<taskId>/        # 每次 invocation 的 result、usage、diagnostics
dispatch/             # dispatch key
writer.lock/          # 獨占鎖
```

- 單一 conversation 檢查上限約 512 MiB／10,000 個檔案目錄（軟性上限，非 disk quota）；原生 session 檢查上限 8 MiB record、128 MiB file、16,384 entries。
- 沒有自動 TTL 或 pruning；stale-lock 接管僅限上述已驗證 checkpoint 的恢復條件。刪除仍須確認無 writer 後手動移除整個目錄（ID 隨之失效）。
- Log 可能含程式碼、工具輸出或憑證，分享前請自行檢查。

## 設定

唯一設定鍵位於全域 `<agentDir>/settings.json`（不讀取專案 `.pi/settings.json`）：

```json
{
  "pi-subagents": {
    "debugLog": true
  }
}
```

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `pi-subagents.debugLog` | `false` | 僅布林 `true` 啟用；缺少、`false`、字串、格式錯誤皆視為關閉。每次工具呼叫重新讀取 |

啟用後，每個 `failed` task 寫入一份 JSON 到 `~/.pi/logs/pi-subagents/`（內容含 system prompt、task、final／partial response、錯誤與 sub-session 路徑，可能含敏感資訊）。診斷為 best-effort，寫入失敗不影響派遣結果；無自動清理。

## 安全邊界

- 所有 child 以 `--exclude-tools subagent,subagent_status,subagent_cancel,subagent_message` 啟動，無法再次派遣或管理 parent 的 subagents。若 agent 有 shell 權限仍可自行執行 `pi`，需另用 sandbox 限制。
- Child 另載入 startup guard，於第一個 provider request 前驗證 model registry 與 trust；不複製 parent 的臨時 provider、credentials 或一次性 approve。Child 須能自行載入相同 provider 定義。
- **同 process guard reload**：只對同一已驗證 handshake object／invocation，只讀重驗原 startupPath，並重新核對 model／cwd／native ID／thinking／trust。新 lease 保存 serialized JSON 的原始 UTF-8 `Buffer`；檔案以 `readFileSync(fd)` 原始 Buffer 的 `equals` 精確比對，不容錯解碼 UTF-8。依 `lstat → open → fstat → raw read → fstat → lstat` 檢查點核對 regular／非 symlink、bigint dev／ino、size 等於 expected Buffer 長度，並比較前後 mtimeNs／ctimeNs；身份為 0n 或所需 bigint metadata 不可用亦 fail closed。新消耗的 handshake object（即使 payload 相同）沒有重用資格，仍以 `wx` exclusive 建立；拒絕不覆寫外來／變造 receipt、不重建遺失檔案。早期同 process serialized-string lease 僅從其已保存 payload 重建 expected Buffer，再通過全部 raw／metadata 檢查後更新記憶體 cache，不用磁碟解碼字串驗證或接管既有檔案。這不是跨 process 工作恢復或 OS sandbox，receipt 格式及既有 owner／writer admission 不變。
- 上述驗證是**離散檢查點的觀測，不是原子檔案快照或永久禁止外部修改**；不能證明兩檢查點之間每一瞬間均未變、曾修改再還原的變化一定可見，或最後檢查後不再改寫。size 固定於 expected Buffer 長度是接受條件的上限檢查，不是 `readFileSync` 遇並行增長時的硬性配置／讀取記憶體上限；未加 filesystem lock。O_NOFOLLOW 只在平台提供時使用，仍必須通過 descriptor／後置 path 與 bigint metadata 檢查，不改用弱身份 fallback。
- 配置／trust mismatch 明確以 `guard_rejected` 拒絕，不讓 receipt I/O 的 EEXIST 掩蓋；receipt ownership／I/O／驗證失敗以 `guard_failed` 拒絕。兩者均直接 `process.exit(1)` 終止 child（stderr 診斷失敗不阻止退出），不是只 throw 一般 `session_start` handler error；Pi 1.1.0 可將這種普通例外回報為 extension error 後繼續。真實離線 host 回歸捕捉 extension errors、實際 close exit code 與 stub provider admission；不宣稱退出已清空所有 descendants。
- Managed child 的 Shell Tools 為同名前景專用 definitions：不提供 `background` 參數／背景 receipt outputSchema／背景指引，不註冊 `shell_job_status`／`shell_job_cancel`，直接 execute 亦拒絕所有外來 background 欄位。new／resume／ready-query 的 owned spawn 均以共用 `buildManagedChildEnvironment()` 明確將 `shellMode:"foreground-v1"` 加入既有 guard handshake；Shell 與 guard 任一先載入者消耗環境，process-local copy 保留 reload 身份而不傳給無關孫行程。不以 RPC／JSON／cwd 或 prompt 推測，不改 child tools 白名單、recursion exclusions、owner／trust 或主代理背景工具。這不是 OS sandbox，也不能阻止有 shell 權限者自行建立 OS 背景行程。詳見 Shell Tools README。
- Process isolation 不是 credential 隔離或 OS sandbox。只使用你信任的 agents。

## 輸出契約與 structuredContent

- 同步建立（single／parallel／chain）結果除 `content` 外附 `structuredContent`：`{ mode, status, results: [{ taskId, agent, status, exitCode, canResume, subagentSessionId?, logPath?, errorCode?, stopReason?, summary? }] }`；`summary` 為同一最後有效 terminal 摘要（最多 256 bytes），完整輸出仍在 `content` 與 sub-session log。
- `subagent_status` 的 outputSchema 對 `result`（status、exitCode、canResume、logPath、output…）、`controls`、`queries` 有具體型別，並允許額外欄位。
- Bundled agents（scout／worker／planner／reviewer）與 prompts 要求：首行一句結論、長細節寫檔只回傳路徑、全文長度上限（約 400–500 字）；prompts 提醒各 step 為隔離 context，task 須帶具體路徑。
- `subagent_status` 的 outputSchema 為 `Type.Union([單一 job receipt, jobs 列表])`（anyOf）。已核對 Pi 1.0.0 原始碼：host 只把 `outputSchema` 當 codemode 的型別宣告（`schemaToType` 支援 anyOf），不驗證 structuredContent、也不要求 object 型別，故可註冊。
- 模型可見文字瘦身：背景 receipt／status／cancel／通知的 `content` 只含下一步所需欄位（taskId、agent、status、subagentSessionId、live／finalLogPath、result 的首行摘要／logPath／canResume／錯誤、usage 的 totalTokens／cost）；操作所需否定資訊 cancelRequested／canMessage／logPending／已知 canResume 的 false 明確輸出；`exitCode: 0`、`stopReason: "stop"`、空 controls／queries、重複的 agent／status／model／完整 usage 仍省略。`subagent_message` 文字與 structuredContent 均包含實際 action、穩定 session ID、適用 invocation／interaction ID 與受理狀態；拒絕時帶診斷及 nextAction。`structuredContent`（只給 codemode）與 `details`（TUI renderer）維持完整 receipt。
