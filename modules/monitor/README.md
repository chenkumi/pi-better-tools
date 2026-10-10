# Monitor v1（原生）

入口 `modules/monitor/src/index.ts`；僅支援 Pi **1.1.0**。三個工具均 `defaultActive:true`，一般 session 載入即預設啟用 `monitor_start`、`monitor_status`、`monitor_stop`，不需加入 `defaultTools`；explicit `--tools`、`--exclude-tools`、`--no-tools` 及手動停用仍由宿主控制，不強制改 loadout；載入不建立來源、timer 或模型請求。Explicit managed-child marker 下完全不註冊，直接 execute 同樣拒絕。不是 OS daemon、排程器、PTY 或 sandbox。

## 使用

```json
{"source":{"kind":"command","tool":"bash","command":"printf 'one\\ntwo\\n'"},"durationMs":300000,"wakeAgent":false}
```

`monitor_start` 的 `source` 必須是以下一種（未知欄位拒絕）：

- `command`：`tool:"bash"|"powershell"`、`command`。使用 trust-aware 有效 Shell settings、宿主 shell resolver/environment/detached tracking/cancellation；Monitor 窄 adapter 保留 stdout/stderr 分流及實際 `close`。stdin ignored、非 PTY；PowerShell 僅原生 Windows。Legacy WSL stdin-command transport 明確拒絕，不退回另一 shell。Pi 1.1.0 的內部 backend 相對安裝 host 解析，缺少能力或版本不同 fail closed，未複製／包入 host code；既有 Shell foreground/background execution 不改。
- `websocket`：`url`、可選 `allowPrivateNetwork`／`allowInsecure`。預設公網 wss；私網與 ws 分別須本次 URL 明確 opt-in。不接受 userinfo、任意 headers、alternate scheme、redirect 或 compression；TLS certificate verification 保留。DNS 所有結果均驗證，actual connect 自訂 lookup 使用同一 immutable IP set，不再次無約束解析；SNI 維持 hostname。固定 direct `ws@8.22.0`，無必要 optional native addon。Handshake 最多15秒且不超總期限；16KiB aggregate payload cap 在 ws receive/reassembly 前執行，binary terminal failure、不自動重連。URL 回報只留 origin，path/query/fragment 不公開。
- `shell_job`／`subagent_job`：`jobId`、可選 `intervalMs`（預設60000、30000–300000整數）。只取得當前 owner/canonical cwd/runtime-generation readonly capability；缺少 provider、外來 job、revoke 均拒絕。Subagent 必須走既有 provisional view，不公開 private query 答案，不 query 模型／讀 logs。停止只清 sampling timer，不取消被觀察 job。Terminal observation 不冒充第二份 task_result。

### 命令授權範圍（設計決策）

`monitor_start` 的 `source.kind:"command"` 由 Monitor 自行啟動 backend，不經巢狀 `bash` 的 `tool_call` hooks；因此只拒絕 `bash` 的 policy **不會**阻止 Monitor command source，policy 必須針對 `monitor_start`（可檢查 `input.source.command`）。這是目前明訂的授權範圍，不是已證實的權限漏洞，也不會偷偷啟用 `bash`；若產品要求兩者同範圍，需另行決定（例如 `ctx.executeTool`）。`tests/command-authorization.integration.test.mjs` 鎖定：直接 bash 被拒、可針對 `monitor_start` 攔截；「bash-deny 也涵蓋 Monitor」以 `todo` 記錄。
共通 `durationMs` 預設300000、1000–1800000整數，包含 startup；不是 Shell idle `timeoutMs`。`wakeAgent` 預設true；false 的 display custom message 不要求模型回合。`stopAfterEvents` 可選1–600，計採納資料事件；`label` 可選80字、清控制碼。Start 立即回 pending receipt；acceptance 後 runtime 接管，不跟著原工具 call 的晚到 abort 停止。Status `{monitorId?}` 唯讀，省略列最多32；Stop `{monitorId}` 冪等、可能先回 stopping/cleanupPending。

## 限制與證據

每 owner 4 active／32 retained，active/pending 不可 evict；rolling60秒最多60 data、總600。Event16KiB；待送每 monitor128 data／256KiB、owner512KiB。stdout byte-line parser 處理跨chunk UTF8、CRLF、EOF、空行、invalid UTF8 partial；oversize 在 decode 前拒絕，stderr只8KiB diagnostic tail（非 data）。文字preview2048 bytes；batch最多32 events／32KiB、owner progress最多每30秒一次。Job pending snapshot 可 coalesce，省略採樣計數保留；command/WS 保留順序。

Job snapshot submission transaction：selected/in-flight事件仍留queue並計入pending/owner byte quotas，不可被send callback同步採樣coalesce成omitted；成功依selected identities計submitted並釋放對應bytes，callback內的新snapshot留下一批。同步send throw不commit cursor／submitted，selected identities與charged bytes保留待下一合法機會，後續採樣只coalesce未reserved的latest pending snapshot；原最多3次同步失敗與retained/cap限制不變，不新增timer。這是同步拒絕的原retry政策，不代表host ack，也不重播已submitted或非同步delivery_unknown事件。

投遞採跨 Monitor round-robin：每輪每個 eligible pending Monitor 只取下一筆，成功送出後，若有byte-blocked head，下一批優先第一個遭byte cap拒絕的來源，否則cursor從最後獲服務者的下一個開始；不跳過同一來源的早期資料。整批以包含 receipt/terminal metadata 的完整 JSON 計量，仍最多32 events／32KiB，每owner最多30秒一次。四來源短事件 busy backlog（前三各60筆、第四已終結）首批皆有事件及終結 receipt；32個短 terminal receipts 的 started／source_closed 尾事件最多兩批。當 byte cap 容不下所有來源時，下一批旋轉優先機會；對每個單筆加metadata能獨立放入batch的 eligible source，固定競爭集合最多32來源，首次代表性metadata在最多32個成功批次內（不是wall-clock保證，busy／send failure仍會延後）。Terminal state/cleanup evidence 隨該來源第一筆選取事件提供，不必等歷史尾端 source_closed；無刪除command/WS歷史來換公平性。每來源 sequence保持順序；最多三次同步send失敗後不再承諾投遞。

Stop-reason system event只記一次；stop／expiry／fault要求先提交時，晚到actual close另外產生`source_closed`終結更新（未close而settle則`terminal`/cleanup unknown），不重播先前submitted資料。

Busy 由 `agent_start`／`agent_settled` 控制；不使用 agent_end／preflight latch。同步 send throw 保留 batch，最多3次、下一合法機會重試；非同步提交無可靠宿主 ack，submitted 不表示 delivered/persisted，未知 delivery 不重播。Shutdown/reload/owner loss 抑制舊owner回送，不恢復來源／receipt。等待 close 最多2秒後可留下 cleanup unknown；晚到 close 才補真正 evidence，不冒稱 descendants 已清理。Actual command close、WS close、timer cleared 各有來源證據，exit/result/cancel request 都不能替代 close。

### 去密邊界（不是任意來源資料 scrubber）

URL origin-only preview、generic network failure等 **Monitor自產metadata** 隱藏path/query/fragment，userinfo直接拒絕；這不等於任意stdout、WebSocket text/closeReason或command stderr全面去密。明確選定的已知URL echo政策：server若原樣回送query值，該值仍當untrusted returned data保存／投遞，包括有界closeReason；不對URL query值做自動replacement，也不承諾萬能scrub。使用者應只監控允許分享輸出的端點／命令，避免真實機密會被來源echo的URL與輸出。離線測試使用唯一非真實secret marker，分別驗自產preview隱藏與text/closeReason保留，避免把正常不echo案例誤當全面去密保證。stderr同樣只有byte bound與diagnostic隔離，不是credential filter。

## `monitor_event` producer v1／Blackhole 窄交接

Pi custom message：`customType:"monitor_event"`、`display:true`，固定 untrusted-data 說明＋JSON，details 權威（正文非指令）。`wakeAgent:true` 用 `triggerTurn:true,deliverAs:"followUp"`；false 不要求turn。Details：

- `schemaVersion:1`、`batchSequence`（owner runtime 遞增）。
- `events[]`：`eventId`／`monitorId`（uppercase ULID）、`sequence`（per-monitor）、`observedAt`、`category:"data"|"system"`、`kind`、可選 `text`／`snapshot`、`partial`、`originalBytes`。
- `monitors[]`：`monitorId`、`source`、`state`、可選 `stopReason`、`cleanupPending`、`cleanupEvidence`、`omitted`。Command cleanup：`sourceClosed`、`exitCode?`、`signal?`、`spawnError?`、`processTreeState:"unknown"`；WS：`closeCode?`／有界 `closeReason?`；job：`timerCleared`／`observedJobCanceled:false`。
- `partial`；`submission:{state:"submitted",hostAcknowledgment:"unknown"}` 只描述提交意圖／callback返回，非真正持久化ack。

`tests/fixtures/producer.ts` 的 `buildProducerFixtures()` 用實際核心與 Pi SessionManager 產生 success/failure/rate/expiry/cleanup-unknown persisted custom_message fixtures；`tests/producer.test.ts` 驗證 host shape。交由父agent接 Blackhole allowlist，代表性異常／terminal引用，不把每tick塞summary、不改old #N。本模組未修改Blackhole，不能宣稱壓縮共存已驗收。

## 驗證

根 `npm run test:module -- monitor` 包含 strict typecheck、deterministic-clock單元、local command/WS transports、installed ws DNS/TLS/redirect probes、隔離離線 Pi1.1.0 host 的兩載入順序／四sources／managed child／reload。`tests/fixtures/monitor-production.mjs` 是乾淨 production deps 真實loader的 command＋WS／readonly provider registration probe；由根package runner複製執行。外部providers=0；合成provider只本地stub。人工TUI、真實遠端端點、其它OS與付費provider未由這些測試證明。
