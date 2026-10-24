# Monitor v1（原生）

入口 `modules/monitor/src/index.ts`；僅支援 Pi **1.4.0**。三個工具均 `defaultActive:true`，一般 session 載入即預設啟用 `monitor_start`、`monitor_status`、`monitor_stop`，不需加入 `defaultTools`；explicit `--tools`、`--exclude-tools`、`--no-tools` 及手動停用仍由宿主控制，不強制改 loadout；載入不建立來源、timer 或模型請求。Explicit managed-child marker 下完全不註冊，直接 execute 同樣拒絕。不是 OS daemon、排程器、PTY 或 sandbox。

## 使用

```json
{"source":{"kind":"command","tool":"bash","command":"printf 'one\\ntwo\\n'"},"durationMs":300000,"wakeAgent":false}
```

`monitor_start` 的 `source` 必須是以下一種（未知欄位拒絕）：

- `command`：`tool:"bash"|"powershell"`、`command`。使用 trust-aware 有效 Shell settings、宿主 shell resolver/environment/detached tracking/cancellation；Monitor 窄 adapter 保留 stdout/stderr 分流及實際 `close`。stdin ignored、非 PTY；PowerShell 僅原生 Windows。Legacy WSL stdin-command transport 明確拒絕，不退回另一 shell。Pi 1.4.0 的內部 backend 相對安裝 host 解析，缺少能力或版本不同 fail closed，未複製／包入 host code；既有 Shell foreground/background execution 不改。Command source 對「shell 先結束、後代程序仍持有 stdout/stderr pipe」有界處理：shell 結束後 stdout/stderr 靜默 250ms 即視為 source 結束（`exitIdleMs`），abort 若早於任何輸出，最多延後 500ms 才由宿主終止（`abortGraceMs`；數值同 Schedule Prompt）。因此 `cmd & echo done` 類指令在 shell 結束後約 250ms 結算，不再因後代持有 pipe 而永久停在 `stopping`／佔用 active 名額。此時 `sourceClosed:true` 只代表 shell 已結束且輸出靜默，**不代表後代程序已停止**，`processTreeState` 仍為 `unknown`；結算後後代的輸出不再進入事件流（shell 結束後仍有靜默超過 250ms 的後代輸出會被捨棄）。取消要求或結算都不等於 process tree 已清理，也不跨 reload 重播。回歸測試：`tests/sources.integration.test.ts` 的 MON-01。
- `websocket`：`url`、可選 `allowPrivateNetwork`／`allowInsecure`。預設公網 wss；私網與 ws 分別須本次 URL 明確 opt-in。不接受 userinfo、任意 headers、alternate scheme、redirect 或 compression；TLS certificate verification 保留。DNS 所有結果均驗證，actual connect 自訂 lookup 使用同一 immutable IP set，不再次無約束解析；SNI 維持 hostname。固定 direct `ws@8.22.0`，無必要 optional native addon。Handshake 最多15秒且不超總期限；16KiB aggregate payload cap 在 ws receive/reassembly 前執行，binary terminal failure、不自動重連。URL 回報只留 origin，path/query/fragment 不公開。
- `shell_job`／`subagent_job`／`fork_job`：`jobId`、可選 `intervalMs`（預設60000、30000–300000整數）。只取得當前 owner/canonical cwd/runtime-generation readonly capability；缺少 provider、外來 job、revoke 均拒絕。Subagent 必須走既有 provisional view，不公開 private query 答案，不 query 模型／讀 logs。停止只清 sampling timer，不取消被觀察 job。Terminal observation 不冒充第二份 task_result。三種 provider 另可選發布唯讀 `briefs()`（只有 kind／jobId／status，僅未結束的 job），由 `activeJobBriefs(scope)` 彙整（單 kind 上限 16 筆、provider 例外標 partial）供 Blackhole 壓縮摘要的 `[Background Jobs]` 提醒使用；不含指令、task 文字、output、路徑，也不能取消或查詢模型。
- `fork_job`：Fork 模組在 `session_start` publish、`session_shutdown` revoke 的唯讀 capability；snapshot 只有 `jobId`、`status`、`cancelRequested`、`delivery`、`createdAt`（有值才附 `startedAt`／`endedAt`）、`elapsedMs`、可選 `cleanup{childClosed,exitCode}`／`transcript{state,path(≤400字,清控制碼)}`／`blocked{reason(≤200字,清控制碼),pending{shell,subagents},since}`；**不含任務全文、result output、usage 或 native session path**，Fork 結果仍只經自己的 `fork-result` 通知投遞。取樣只在已知終態（`completed`／`failed`／`cancelled`／`timed_out`／`interrupted`）停止，其餘狀態持續；job 類來源只保證「最新狀態」——未送出的舊快照會被新快照取代，`blocked` 這類短暫中間狀態若在送出前已改變就不會送達（`fork_status` 才是完整來源）；Fork 所在 session 被取代（new／resume／fork）時 provider 立即 revoke，該 monitor 會以 `source_error` 結束，但 Fork 本身與 `fork-result` 投遞不受影響；不取消 Fork、不 resume、不查模型。`fork_job` 沒有 Shell 那種自動請求，必須明確 `monitor_start`；建議搭配 `wakeAgent:false`，因為 Fork 完成仍會由自己的 `fork-result` 要求一個 parent 回合，不需要第二個 monitor 回合；`/reload`、owner 或 canonical cwd 改變、`state().epoch` 增加都會讓 lease 失效。回歸測試：`tests/fork-source.test.ts`（取樣／abort／缺少 provider）與 `modules/fork/tests/monitor-capability.test.ts`（投影邊界、scope、revoke、observation-only）。
- `file`：`path`、可選 `intervalMs`（1000–60000 整數，預設2000）。**只回報 metadata**（`path` 相對 canonical cwd、`change`＝`created`／`modified`／`deleted`、`exists`、`sizeBytes`、`mtimeMs`），絕不讀取或回傳檔案內容。目標必須在 owner canonical cwd 內：啟動時先做詞法檢查（絕對路徑若經連結的父目錄指回專案，例如 macOS `/tmp`→`/private/tmp` 或 junction，先將最近的既有父目錄 `realpath` 化再比較，最後一段不跟隨），再對目標（不存在則對最近的既有祖先）做 `realpath` 包含檢查，專案外路徑、離開專案的 symlink／junction、目錄或非一般檔案一律在接受前拒絕且不留 receipt；每次採樣重新檢查，執行中被換成指向專案外的連結則以 `path_outside_workspace` fault 終止，不外洩外部 stat。僅輪詢、不用 `fs.watch`（Windows／網路磁碟事件不可靠），起始狀態是 baseline 不產生事件，之後每個 tick 最多一個事件（簽章＝size＋mtime 整數毫秒＋inode，新舊比較），最小間隔1秒因此不會撞到每分鐘60筆的上限；同 tick 內的多次變更合併為一個事件。限制：mtime 粒度粗且大小不變的快速改寫可能漏報；事件順序保留、不 coalesce；停止只清 timer，不影響檔案。回歸測試：`tests/file-source.test.ts`。

`shell_job` 另有 Shell 自動請求：背景 `bash`／`powershell` job 未設 `timeoutMs` 時，Shell 經 `monitor-capability.ts` 的 rendezvous 請 Monitor 啟動 `intervalMs:180000`、`wakeAgent:false`、`durationMs:1800000`、label `auto: shell job without timeoutMs` 的來源。僅在 `monitor_start` 已選取、owner／cwd 相符且仍有 active 名額時接受，否則靜默略過；與手動啟動同一授權、同一限制，不取消被觀察 job。

### 命令授權範圍（設計決策）

`monitor_start` 的 `source.kind:"command"` 由 Monitor 自行啟動 backend，不經巢狀 `bash` 的 `tool_call` hooks；因此只拒絕 `bash` 的 policy **不會**阻止 Monitor command source，policy 必須針對 `monitor_start`（可檢查 `input.source.command`）。這是目前明訂的授權範圍，不是已證實的權限漏洞，也不會偷偷啟用 `bash`；若產品要求兩者同範圍，需另行決定（例如 `ctx.executeTool`）。`tests/command-authorization.integration.test.mjs` 鎖定：直接 bash 被拒、可針對 `monitor_start` 攔截；「bash-deny 也涵蓋 Monitor」以 `todo` 記錄。
共通 `durationMs` 預設300000、1000–1800000整數，包含 startup；不是 Shell idle `timeoutMs`。`wakeAgent` 預設true；false 的 display custom message 不要求模型回合。`stopAfterEvents` 可選1–600，計採納資料事件；`label` 可選80字、清控制碼。Start 立即回 pending receipt；acceptance 後 runtime 接管，不跟著原工具 call 的晚到 abort 停止。Status `{monitorId?}` 唯讀，省略列最多32；Stop `{monitorId}` 冪等、可能先回 stopping/cleanupPending。

### 活躍 monitor 清單（Blackhole 壓縮提醒）

Monitor 在 `session_start` 另經 `monitor-capability.ts` 發布 `publishActiveMonitorBriefs`（scope 同 owner session ＋ canonical cwd），`session_shutdown` 先 revoke。`activeMonitorBriefs(scope)` 回傳**未終結** monitor 的窄投影：`monitorId`、`source`（kind）、`state`（starting／running／stopping）、`target`（file 為 `source.path`、websocket 只留 origin、command 為 `[command withheld]`、job 為 jobId）、可選 `label`、`remainingMs`；上限16筆，reader 例外或 malformed row 只標 `partial`。投影不含命令文字、URL path／query、事件、output 或任何控制把手，不能 stop／cancel／查模型，也不代表已交付。Blackhole 的 `[Active Monitors]` 區塊即讀此清單，只代表壓縮當下。

## TUI 與 Agent 投遞

`monitor_event` 已註冊原生訊息 renderer，與 Shell／Fork 通知使用相同主題背景面板與內距，依狀態用 success／error／pending；收合顯示來源狀態、短 ID 與末三筆事件，原生展開看完整 IDs、最多32筆事件及具名 job snapshot 欄位。顯示清理 ANSI／控制碼／bidi、依終端欄寬截短／換行、最多300行；renderer 不執行工具、不修改模型正文或 details，不將來源輸出當作終結／清理證據。舊的 prose＋JSON body 可有界解析；缺欄位安全顯示 unknown，不重寫已存訊息。

- `wakeAgent:true`（預設）：`pi.sendMessage` 的 `triggerTurn:true, deliverAs:"steer"`，要求 Agent 回合；與 Shell／Subagent 完成通知一致：主 Agent 忙碌時也直接提交，由 Pi 的 steering 佇列在安全的回合邊界插入，不等 `agent_settled`；保留每 owner 30 秒節流。核心的 `setBusy` 只是 embedder 的選用保留閥，Pi extension 不呼叫。
- `wakeAgent:false`：custom message 仍保存並加入模型上下文，只是不主動要求新模型回合；下次正常請求可讀到，不是只有使用者看得到。Shell 自動 Monitor 固定此模式，避免每次採樣額外呼叫模型；原 Shell job 完成通知另行喚醒。
- 面板分別顯示 `Agent turn requested`／`Display only · no Agent turn requested`；batch 中任一選中來源為true即要求turn。舊訊息缺少欄位顯示 unavailable，receipt 與新批次 metadata 都提供每來源 `wakeAgent`。這是請求模式而非 host acknowledgment，不保證 Agent 一定產生文字回覆。

## 限制與證據

每 owner 4 active／32 retained，active/pending 不可 evict；rolling60秒最多60 data、總600。Event16KiB；待送每 monitor128 data／256KiB、owner512KiB。stdout byte-line parser 處理跨chunk UTF8、CRLF、EOF、空行、invalid UTF8 partial；oversize 在 decode 前拒絕，stderr只8KiB diagnostic tail（非 data）。文字preview2048 bytes；batch最多32 events／32KiB、owner progress最多每30秒一次。Job pending snapshot 可 coalesce，省略採樣計數保留；command/WS 保留順序。

Job snapshot submission transaction：selected/in-flight事件仍留queue並計入pending/owner byte quotas，不可被send callback同步採樣coalesce成omitted；成功依selected identities計submitted並釋放對應bytes，callback內的新snapshot留下一批。同步send throw不commit cursor／submitted，selected identities與charged bytes保留待下一合法機會，後續採樣只coalesce未reserved的latest pending snapshot；原最多3次同步失敗與retained/cap限制不變，不新增timer。這是同步拒絕的原retry政策，不代表host ack，也不重播已submitted或非同步delivery_unknown事件。

投遞採跨 Monitor round-robin：每輪每個 eligible pending Monitor 只取下一筆，成功送出後，若有byte-blocked head，下一批優先第一個遭byte cap拒絕的來源，否則cursor從最後獲服務者的下一個開始；不跳過同一來源的早期資料。整批以包含 receipt/terminal metadata 的完整 JSON 計量，仍最多32 events／32KiB，每owner最多30秒一次。四來源短事件 busy backlog（前三各60筆、第四已終結）首批皆有事件及終結 receipt；32個短 terminal receipts 的 started／source_closed 尾事件最多兩批。當 byte cap 容不下所有來源時，下一批旋轉優先機會；對每個單筆加metadata能獨立放入batch的 eligible source，固定競爭集合最多32來源，首次代表性metadata在最多32個成功批次內（不是wall-clock保證，busy／send failure仍會延後）。Terminal state/cleanup evidence 隨該來源第一筆選取事件提供，不必等歷史尾端 source_closed；無刪除command/WS歷史來換公平性。每來源 sequence保持順序；最多三次同步send失敗後不再承諾投遞。

Stop-reason system event只記一次；stop／expiry／fault要求先提交時，晚到actual close另外產生`source_closed`終結更新（未close而settle則`terminal`/cleanup unknown），不重播先前submitted資料。

通知不等主 Agent 回合結束：以 `steer` 直接提交（Pi 的 steering 佇列在安全回合邊界插入），核心的 `setBusy` 只是 embedder 的選用保留閥、Pi extension 不呼叫。同步 send throw 保留 batch，最多3次、下一合法機會重試；非同步提交無可靠宿主 ack，submitted 不表示 delivered/persisted，未知 delivery 不重播。Shutdown/reload/owner loss 抑制舊owner回送，不恢復來源／receipt。等待 close 最多2秒後可留下 cleanup unknown；晚到 close 才補真正 evidence，不冒稱 descendants 已清理。Cleanup unknown 的上一代來源不再使 `bind()` 失敗而讓整個行程的 Monitor 失效：它們留在 retired 集合（仍追蹤、仍計入 active 上限 4，新 owner 無法讀取或操作），未結清世代累積到 4 個時才拒絕下一次 bind；來源終於 close 後名額即歸還。WebSocket 在 DNS／前置階段被 `monitor_stop`、shutdown 取消時終結為 `startupCanceled`（非 `source_error`）；單純逾時仍是失敗。Actual command close、WS close、timer cleared 各有來源證據，exit/result/cancel request 都不能替代 close。

### 去密邊界（不是任意來源資料 scrubber）

URL origin-only preview、generic network failure等 **Monitor自產metadata** 隱藏path/query/fragment，userinfo直接拒絕；這不等於任意stdout、WebSocket text/closeReason或command stderr全面去密。明確選定的已知URL echo政策：server若原樣回送query值，該值仍當untrusted returned data保存／投遞，包括有界closeReason；不對URL query值做自動replacement，也不承諾萬能scrub。使用者應只監控允許分享輸出的端點／命令，避免真實機密會被來源echo的URL與輸出。離線測試使用唯一非真實secret marker，分別驗自產preview隱藏與text/closeReason保留，避免把正常不echo案例誤當全面去密保證。stderr同樣只有byte bound與diagnostic隔離，不是credential filter。

## `monitor_event` producer v1／Blackhole 窄交接

Pi custom message：`customType:"monitor_event"`、`display:true`，固定 untrusted-data 說明＋JSON，details 權威（正文非指令）。`wakeAgent:true` 用 `triggerTurn:true,deliverAs:"steer"`；false 為 `triggerTurn:false`（Pi 在此情況不使用 `deliverAs`，串流中由 Pi 延到回合結束附加）。Details：

- `schemaVersion:1`、`batchSequence`（owner runtime 遞增）。
- `events[]`：`eventId`／`monitorId`（uppercase ULID）、`sequence`（per-monitor）、`observedAt`、`category:"data"|"system"`、`kind`、可選 `text`／`snapshot`、`partial`、`originalBytes`。
- `monitors[]`：`monitorId`、`source`、`wakeAgent`、`state`、可選 `stopReason`、`cleanupPending`、`cleanupEvidence`、`omitted`。Command cleanup：`sourceClosed`、`exitCode?`、`signal?`、`spawnError?`、`processTreeState:"unknown"`；WS：`closeCode?`／有界 `closeReason?`；job：`timerCleared`／`observedJobCanceled:false`。
- `partial`；`submission:{state:"submitted",hostAcknowledgment:"unknown"}` 只描述提交意圖／callback返回，非真正持久化ack。

`tests/fixtures/producer.ts` 的 `buildProducerFixtures()` 用實際核心與 Pi SessionManager 產生 success/failure/rate/expiry/cleanup-unknown persisted custom_message fixtures；`tests/producer.test.ts` 驗證 host shape。交由父agent接 Blackhole allowlist，代表性異常／terminal引用，不把每tick塞summary、不改old #N。本模組未修改Blackhole，不能宣稱壓縮共存已驗收。

## 驗證

根 `npm run test:module -- monitor` 包含 strict typecheck、deterministic-clock單元、local command/WS transports、installed ws DNS/TLS/redirect probes、隔離離線 Pi1.4.0 host 的兩載入順序／四sources／managed child／reload。`tests/fixtures/monitor-production.mjs` 是乾淨 production deps 真實loader的 command＋WS／readonly provider registration probe；由根package runner複製執行。外部providers=0；合成provider只本地stub。真實宿主 fixture 另驗預設true實際觸發離線模型回合且上下文含來源marker，false不新增回合；renderer測試含展開／收合、窄寬／Unicode、控制碼、legacy與unknown。人工TUI、真實遠端端點、其它OS與付費provider未由這些測試證明。
