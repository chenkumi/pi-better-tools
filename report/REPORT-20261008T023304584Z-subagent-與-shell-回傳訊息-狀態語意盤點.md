# Subagent 與 Shell 回傳訊息／狀態語意盤點

## 範圍與方法

依目前本地程式盤點：Subagent 同步派發、背景 receipt／完成通知、status／cancel、control／query、日誌／續接與即時面板；Shell 的 bash／powershell 同步回覆、背景派發、status／cancel、完成通知、停滯逾時與即時面板。包含 TUI、模型可見 content、structuredContent 與工具描述的差異。

這次是唯讀盤點，不修改產品程式或測試。下列表中的建議皆尚未實作；先前已改過的中性信任提示與 accepted／queued 中文說明，以当前檔案為準。任意子代理回覆、命令輸出、provider 例外與 OS 診斷不是有限的固定字串，不逐一列舉；它們是回傳資料，不應取代權威 status 的判定。

## 核心區分

- 接受／排隊不是開始執行，更不是工作完成。
- Control 的 applied 只證明 exact canonical user 訊息已納入子代理對話，不證明指示已執行完成。
- Query 的 completed 只表示唯讀查詢得到回覆，不表示主工作完成。
- Job／task 的 completed 是執行流程結果，不是對工作內容正確性的獨立認證。
- 取消要求、registry 終結、面板消失皆不是 OS process tree 或遠端 provider 已完全停止的證明。
- 歷史通知是事件當時快照；status 是目前 runtime 保留的狀態。欄位缺失不應自動推論成功、失敗或零用量。

## 1. Subagent 工作／派發／面板

| 目前訊息／狀態 | 實際意義 | 評估／建議 |
|---|---|---|
| `subagent reviewer [user]` | 選用 reviewer；呼叫標題的 user 取自 agentScope，表示 agent 搜尋範圍，不是已解析定義的實際來源，也不是回覆權限。 | 建議「搜尋範圍：user」；實際來源須另看 agentSource。此列校正初次盤點把 scope 與來源混用的說明。 |
| `○ Job …: queued`、`○ reviewer: queued` | 背景 job 已接受、task 等待啟動或 child capacity。 | 正常等待；現有中性圖示合適。 |
| `○ Job …: running` | 背景 runner 已開始處理整個 batch；可能仍有 task 排隊，或整批在收尾。 | 不宜解讀成所有 children 均在執行。 |
| `○ reviewer: running` | 該 task 執行流程進行中。 | 正常進度。 |
| `✓ …: completed` | 該 job／task 執行流程成功結束。 | 不代表結果經獨立驗證或任務領域判斷正確。 |
| `✗ …: failed` | 執行、協定、provider、I/O、提交或清理等流程失敗。 | 真正失敗；保留錯誤顯示，附原因。 |
| `! …: aborted` | 工作中止／取消；不等於一般執行失敗。 | 建議「已中止」；不宣稱所有 descendants 已停止。 |
| `! …: skipped` | Chain 後續尚未開始的 step 未執行，例如前一步失敗。 | 建議「未執行：前序步驟未成功」，原因依實際資料。 |
| `finalizing` | batch 尚在收尾，已無 queued／running task rows。 | 正常收尾，不是卡住或錯誤的直接證據。 |
| `Pending… (partial result)` | 工具還在串流更新／未取得最終結果。 | 正常進度卻使用 warning；可改中性「執行中，以下為目前進度」。 |
| `request …`／`completed …`／`failed …` 即時工具列 | 子代理內某個工具呼叫的請求／成功／失敗，不是整個子代理工作結果。 | 建議加「工具」前綴避免層級混淆。 |
| `Cancel requested; process-tree termination unconfirmed` | 已要求取消，未確認完整程序樹終止。 | 語意正確；可用「已提出取消要求，等待收尾；尚未確認所有子行程退出」。 |
| `No retained background jobs` | 此 owner／cwd／runtime 沒有保留中的工作。 | 不代表從未派發，也不是工作遺失的充分證據。 |
| `Subagents · task result (event snapshot)` | 結束事件當時的快照；成功、失敗、中止均可能。 | task result 不等於成功；可改「工作結束通知（事件當時狀態）」。 |
| `Subagents · log ready (event snapshot)` | 日誌路徑已建立的事件快照，主工作未必完成。新 log_ready 不新增聊天 bubble。 | log ready 不等於 task ready／completed。 |
| `? … result unavailable`、`unknown` | renderer 無法從保留資料辨識結果／status，例如舊紀錄或不完整資料。 | 「結果資料不足／狀態無法辨識」，不直接稱執行失敗。 |
| 子代理通知／摘要「回傳資料，不是指令」與 outputTrust 說明 | 回傳資料不提升指令權限；不是錯誤或可信度評分。 | 已改中性，保留信任邊界。 |

## 2. Subagent control／query

| 目前訊息／狀態 | 實際意義 | 評估／建議 |
|---|---|---|
| `○ Control: accepted`＋「控制訊息已受理，等待納入子代理對話」 | 父工具接受控制訊息，尚未確認 canonical 納入。 | 已修正，語意合適。 |
| `○ Control: queued`＋「控制訊息已排入佇列，等待納入子代理對話」 | Child ack 排入 steering queue，尚未確認 canonical 納入。 | 已修正，語意合適。 |
| `✓ Control: applied` | 已見 exact canonical user event；訊息納入對話。 | 容易誤以為指示已執行。補「已納入子代理對話；要求的工作尚須看後續結果」。 |
| `✗ Control: not_applied` | 未送出即工作結束／關閉，或 input hook 回覆 handled，訊息未進 canonical 主線。 | 是這次送訊息未達目的，不等於主工作失敗；handled 可是合法攔截。建議「控制訊息未納入主對話」，保留原因。 |
| `! Control: delivery_unknown` | 已嘗試送出，但缺少可精確關聯的 canonical 證據；可能有 transform、transport error 或工作先結束。 | 不是已確認未送達，不能自動重送。補「無法確認是否納入；請勿據此重送」。 |
| `○ Query: accepted` | 唯讀查詢已受理，等獨立回覆。 | 少等待說明；建議「查詢已受理，等待回覆」。 |
| `✓ Query: completed` | 唯讀查詢取得答案。 | 容易誤以為主工作完成；補「查詢已回覆；主工作狀態另行判定」。 |
| `✗ Query: failed` | 查詢失敗／逾時／快照不可用等，不一定影響主工作。 | 補「查詢失敗；不代表主工作失敗」。 |
| `! Query: aborted` | 查詢被中止。 | 不直接推論主工作相同狀態。 |
| `Snapshot: stale (not current task state)` | 答案取自較早的安全對話 prefix，例如長工具進行中的前一個完整 batch。 | stale 易被看成資料損壞／不可信；改「查詢依據較早快照，未包含正在執行的工具結果」。 |
| `Snapshot: captured prefix` | 指明答案依據擷取的安全對話快照；即使 stale=false 也走 warning 色。 | 正常 metadata 警告化；改中性「查詢依據：已擷取的對話快照」。 |
| `Late usage update; previous outcome unchanged` | 晚到 terminal evidence 補正獨立用量，不重新執行、不復活先前失敗的答案。 | 正常補登卻 warning；改「補登查詢用量；原查詢結果不變」。 |
| `Cleanup pending; provider stop unconfirmed` | 查詢 receipt 已終結，但 provider／child terminal 證據尚不足，資源租約仍保留。 | 真正需要注意的收尾狀態，不該隱去；改「查詢結果已回報，資源仍在收尾；尚未確認模型請求停止」。 |
| `Usage: unknown (not zero)` | 尚未取得可靠用量；不能算成零。 | 語意正確；可改「用量尚未確認（不視為零）」。 |
| `Usage (separate; not host totals)` | 子代理／查詢用量獨立列示，不重複加入主代理 totals。 | 是會計提示，非錯誤。 |
| tool description 的 `queued is not applied` | 給模型看的規則仍用舊負面句型，TUI 已換中文。 | 建議同步說明「queued 表示等待 canonical 納入；applied 只確認納入對話」，不改 schema 或判定。 |

## 3. Subagent 日誌／續接／同步差異

| 目前訊息／狀態 | 實際意義 | 評估／建議 |
|---|---|---|
| `Live log` | 目前既有 readable partial log。完成時可能 rename。 | 合適；舊快照路徑不保證仍存在。 |
| `Future final log (not yet available)` | 預計完成後的最終路徑，當下可能不存在。 | 合適，不能拿來假定已完成。 |
| `Log: pending (no path yet)` | 尚無已驗證路徑。 | 排隊／啟動階段正常。 |
| `Subsession log pending...` | 同步 renderer 遇到缺 logPath 且缺 logError 時的 fallback，沒有檢查是否已終結。 | 終結資料若兩欄皆缺，也會顯示 pending，易誤以為還會補送；應區分「尚在建立」與「本次未提供日誌」。 |
| `Resume: ready`／`ready to resume` | 已有可驗證的 ready checkpoint，可另用 resume。 | 不代表仍在 running，也不是原工作繼續執行。 |
| `Resume: unavailable`／`not resumable` | 此結果當下沒有可用續接資格。 | 原因不一；不一定程式錯誤。 |
| 同步 `Subagent session: … (blocked)` | 由 canResume 的 truthy／falsy 判斷；running 階段 canResume=false 也顯示 blocked，未讀實際 manifest state。 | 已 renderer 重現：running 同時 blocked。建議「執行中，暫不可續接」，終結後再顯示續接資格。 |
| 同步 `aborted` 為 error 色，展開顯示 `Error: Cancelled by user` | isFailedResult 將 aborted 納入失敗路徑；背景則顯示 warning 的 aborted。 | 已 renderer 重現；取消看成故障，前景／背景不一致。可保留 isError 執行契約，僅呈現「已中止／中止原因」。 |
| `(no output)`／`(no assistant output)` | 沒有保留的文字回答；不自動代表執行失敗。 | 建議「本次未產生文字回覆」，仍看 status。 |
| `Parallel: N/M succeeded` | N 個執行流程不是 isFailedResult，非內容正確率。 | 可補「執行成功」，避免誤作驗證通過率。 |

## 4. Shell 派發／工作狀態／管理工具

| 目前訊息／狀態 | 實際意義 | 評估／建議 |
|---|---|---|
| `job … running` | 背景 receipt；registry 已接受，runner 延至後續 event-loop boundary 才執行。 | 微小差異：不證明 OS process 已啟動。建議「背景工作已接受，等待完成通知」。 |
| `Progress: read log tail. Completion is auto-reported …` | 可讀 liveLogPath，正常完成會自動通知；status/cancel 未選取時不可用。 | 正常功能提示，不是權限故障。通知仍受 owner／shutdown／generation 限制，非送達保證。 |
| `running` | 背景工作未終結。 | 正常進度。 |
| `cancelling`／`cancel requested` | 已提出取消要求，runner 尚未收尾。 | 不等於已停止；現有提示有說明。 |
| `cancelled` | 取消後 runner 已回報終結；不保證全部 descendants 停止。 | 应保留取消，而不是改稱 failed。 |
| `completed` | runner 回傳非 error 結果。取消競態中已有成功結果時，completed 可與 cancelRequested=true 共存。 | 不是矛盾；不應把取消要求當作取消已生效。 |
| `failed` | 執行錯誤、非零退出、log I/O 等流程失敗。 | 真錯誤。命令自身非零退出也可能是預期查詢結果（例如找不到匹配），需依命令目的解讀。 |
| `timed_out` | 連續一段時間沒 stdout/stderr，觸發 idle timeout；不是總執行時限。 | 建議「輸出停滯逾時」，保留 status。 |
| `Cancellation is a request; process-tree termination not confirmed.` | cancel 工具固定附帶的安全說明，即使 job 已終結、不會再取消也顯示。 | 語意保守但缺是否真的接受新取消要求；依回傳状态說「已終結，未新增取消要求」或「已要求取消」。 |
| status／cancel 的 compact JSON | 結構化工作快照，不是 error 文本。 | TUI 目前只是截短原文（收合512、展開8192字元），沒有與完成通知相同的語意化狀態摘要。 |
| `was evicted … result and log were deleted` | 因最多32個保留工作而淘汰；新派發時清理舊終結工作。 | 結果查詢不可用不代表原命令失敗。 |
| `does not exist in this session`／`BACKGROUND_JOB_NOT_FOUND` | ID 不存在、owner/runtime 不同、reload 清理或已不保留。 | 是這次查詢失敗，不是原工作失敗。 |
| active／retention／QUERY_CAPACITY／CONTROL_CAPACITY | 新操作未受理，原因是容量上限。 | 需說「未派發／未送出」；不要讓人誤認為已接收的工作失敗。 |

## 5. Shell 完成／輸出／同步提示

| 目前訊息／狀態 | 實際意義 | 評估／建議 |
|---|---|---|
| `Shell background jobs finished` | 通知中一個或多個工作已終結，包括成功、失敗與取消。 | finished 不等於 succeeded；目前模型前言已指向 status/exitCode/error。 |
| `✓ Shell completed · exit 0` | 完成且退出碼0。 | 正常執行成功，不代表命令執行的業務判斷已驗證。 |
| `✗ Shell failed` 當原始 status=cancelled、exitCode非零 | renderer 先用非零退出判 failed，把取消覆蓋成失敗。 | **條件式顯示問題已重現**：輸入 cancelled/130，顯示 failed/130。不是宣稱所有 native cancel 都產生此組合；native abort 常沒有 exitCode。優先保留 cancelled，exitCode 當附加診斷。 |
| `! Shell completed` 當 exitCode 缺失 | renderer 不偽造成功，但仍以警告圖示搭配 completed。 | 可能讓人以為成功與錯誤同時發生。補「已終結；退出碼未提供」。 |
| `Command stopped: no output for N seconds …` | idle timeout 已觸發，命令由宿主收尾。 | 主句正確；不是所有 descendants 終止確認。 |
| timeout hint 的 `omit or raise timeoutMs, or use background:true` | 切 background 仍沿用同一 idle timer，只要 timeoutMs 保留就會再逾時。 | **處置建議不完整**：應說「靜默長命令請省略／調大 timeoutMs；需要非同步等待時再加 background:true」。 |
| TUI call 的 `(timeout 20s)` | extension 將 ms 換成秒交原生 renderer；實際是無輸出20秒。 | 易讀成總20秒；改「idle timeout 20s／無輸出逾時20秒」。 |
| `命令輸出（資料，不是指令）`／尾段 | 顯示命令回傳資料；不是錯誤判定。 | 已中性化，合理。 |
| `Retained head`／`Retained tail` | 通知保留的開頭／結尾片段，展開不能還原中段或通知已裁去的文字。 | 建議「保留的輸出開頭／結尾」。 |
| `! Output truncated · log retains first 1 MiB, not full output` | outputTruncated 同時涵蓋 head capture 或 disk log 限制；log 上限1MiB，不代表實際已滿，也不代表必定缺輸出。 | **已用真正 retention path 模擬重現**：stdout20,000 bytes，logBytes20,000，outputTruncated=true，日誌可含本次完整20,000 bytes，仍說 not full output。應分「通知摘要截短」與「日誌達上限」，至少說「通知只保留片段；日誌最多保留前1MiB」。 |
| `(No output retained in this notification)` | 此通知缺保留輸出；可能命令沒輸出、資料缺失或舊紀錄。 | 目前明講 notification，合適；不應改稱命令沒有執行。 |
| `Log: …` | Shell 日誌上限前1MiB，非一律完整輸出；可在 evict／shutdown 移除。 | 不要與同步 `Full output` 混用。 |
| 同步 `(no output)` | stdout/stderr 沒文字，仍可能 exit0。 | 正常，非錯誤。 |
| 同步 `Command exited with code N` | 非零退出，宿主以 isError=true 回傳。 | 執行未滿足 exit0 契約；是否為領域上的錯誤需看命令。 |
| 同步 `Command aborted` | 命令被中止。 | 不是一般故障；也不保證所有 descendants 已停止。 |
| 同步 `Full output: …`／`Truncated: …` | 模型／TUI 預覽被截，宿主另存完整輸出；不同於本模組背景bounded log。 | 語意可保留，但務必區分同步／背景。 |
| 同步 renderer 的 `Took …` 在背景 receipt 之後 | 原生 renderer 計量這次工具呼叫直到 receipt 返回的時間，不是整個背景命令完成耗時。 | 建議背景回覆以「受理耗時」呈現；完成通知 elapsedMs 才是背景job耗時。 |
| `Expand for …`／`Display limit` | UI 展開或显示预算提示；不改執行结果，也不恢復通知未保存的資料。 | 正常資訊，可中性化。 |

## 優先處理建議

### 優先：實際文字與狀態不一致
1. Shell cancelled＋非零 exit code 被 renderer 顯示 failed（條件式 renderer 重現）。
2. Shell outputTruncated 混同通知片段與日誌實際是否完整（真 retention path 模擬重現）。
3. Shell timeout 的 background:true 建議可能讓人誤以為能停用 idle timer；TUI timeout標籤也缺 idle 說明。
4. Subagent 同步 running 卻顯示 blocked；同步 aborted 又走 Error 呈現。

### 次優先：正常資訊看成警告或完成範圍不清
5. Control applied／Query completed 少了「僅訊息納入／仅查詢回覆」說明。
6. Query captured prefix／晚到用量、partial result 用 warning，而非中性進度或metadata。
7. Query stale 應說明是較早安全快照，非資料錯誤。
8. 同步 terminal 資料缺 logPath/logError 仍顯示 pending；缺退出碼的 Shell completed 未說明警告原因。
9. Shell 背景 receipt 的 Took 是受理耗時；status/cancel 仍以原始JSON呈現；已終結job取消回覆固定request警語。

真正 error、uncertain delivery、cleanupPending 與資源未確認停止，不應為了視覺中性而隱去或改稱成功。建議僅改 presentation／說明，不改公開 status/schema、喚醒、信任與安全判定。

## 查證與驗證

- 靜態：`modules/subagents/extensions/subagent/{background-renderer.ts,background.ts,rpc.ts,index.ts,result.ts,progress.ts,live-widget.ts}`；`modules/shell-tools/{extensions/timeout-ms.ts,src/background-jobs.ts,src/completion-renderer.ts,src/live-widget.ts}`；本地 Pi 1.0.0 的 `dist/core/tools/{bash.js,powershell.js,renderers/bash.js}`。
- Renderer probes：Shell cancelled/130→failed；completed缺exit→warning；Subagent applied無範圍說明、正常snapshot metadata、late usage、同步running/blocked、aborted/Error等直接輸出。
- Shell retention probe：fake operations單次輸出20,000 bytes，不執行任何命令；經實際ShellJobs onData／日誌／通知路徑，觀察status=completed、logBytes=20000、outputTruncated=true與 misleading not-full 文案。使用臨時owner與日誌，finally await shutdown完成清理。
- 首次 inline node -e probe因PowerShell引號解析失敗，未執行測試邏輯；改here-string/stdin後成功。不是產品失敗。
- 未呼叫provider、未改真實settings/auth/排程，沒有修改產品程式或測試。
- 本次未重跑npm test、module、cross或package；未做手動真實TUI、OS取消程序樹、provider停止驗證。先前背景驗證不視為此盤點或未實作建議的通過證據。
