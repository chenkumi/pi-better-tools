# 指定 Subagents RPC 啟動失敗紀錄調查

## 任務與範圍
使用者要求檢查 `C:/Users/KY6584/.pi/logs/pi-subagents/2026-10-08T01-38-33-690Z-01m4cjj1383dse0fffth9tjtnb-01m4cjk12t1p3eqkmkwmxg94bt.json`，判斷是否程式碼問題。唯讀調查，不授權修復、不修改真實settings/auth/session、不呼叫真實或付費模型。

## 結論
已確認是child的首次RPC get_state啟動握手未在期限內回覆；不能把stderr新session警語或COMMIT_FAILED當成根因，也不是這次review結果失敗。**未確認可直接歸責本次歷史失敗的程式缺陷**；確認目前實作存在「30秒共用RPC response預算包含child冷啟動」的行為，若初始化遲緩，會在主工作prompt前逾時。這是可靠性設計候選（RPC-STARTUP-001），不是已證明本次誤判。

本次指定日誌為2026-10-08 01:38 UTC的歷史失敗，不是英文訊息套用後的驗證結果。讀取目前程式碼與mock probe不能證明历史CLI版本、phase timings或當時負載。

## 已觀察證據
- Debug log v1，createdAt `2026-10-08T01:38:33.690Z`，SHA token `264e24040f587dd2e3471fef442019a8`。
- status failed／exitCode1／stopReason error；error為 `RPC startup failed: RPC_DEADLINE: get_state response not received`。
- stderr只有宿主警語：找不到指定project session ID，因此以該ID建立新session。此行本身尚不證明失敗根因。
- finalResponse空；指定readable transcript為空（SHA token `e3b0c44298fc1c149afbf4c8996fb924`）。沒有審查結論或主工作工具執行紀錄。
- manifest／run.json均為blocked，errorCode COMMIT_FAILED；run.startedAt `2026-10-08T01:38:01.396Z`，manifest.updatedAt `2026-10-08T01:38:33.488Z`，相隔32.092秒，包含spawn及cleanup，不是精確RPC request latency。
- usage.turns／totalTokens／cost均為0，pi/無native檔案，run目錄只有run.json與空transcript，沒有startup.json。守護寫入位置見session-store.ts:357；blocked/release本身不刪除startup.json。這支持startup未完成／至少沒有guard留下證據，不足以辨別slow init或永久卡住。
- COMMIT_FAILED是runner首次run無canResume時的後續保守fallback（index.ts:951），不是此log證明managed.commit曾失敗；原始原因仍RPC get_state逾時。hostContract 0.99.1是持久格式身份，不是歷史CLI版本。

## 當前程式碼基準（非歷史等價宣稱）
此workspace沒有可用Git；記錄read版SHA tokens：
- modules/subagents/README.md：d4399f58e05387ffd00ee62a3e2aaaf2。
- modules/subagents/extensions/subagent/rpc.ts：e24afbdf9955f2156b2ecba802b0b52f。
- modules/subagents/extensions/subagent/index.ts：b3f9487db8c9500822f01009ddcce717。

## 候選／進度
### RPC-STARTUP-001（是否缺陷／本次因果待驗證，可靠性，Medium）
`RpcPipe.request`在入queue時開始固定30秒response timer；runner啟動時即request get_state，未先等CLI extensions／session_start初始化完成。若child初始化超過30秒，即可能將正常冷啟動判為RPC_DEADLINE。這是待核對的觸發條件，不把本次log直接認定為已確認誤判。

## 靜態查證完成
- child-args.ts:30–32對new使用--session-dir加--session-id，而非要求resume既有session。宿主main.ts:436–448與本地dist/main.js明確先warn後SessionManager.create：已排除把找不到新ID的警語直接當根因。
- index.ts:847立即request get_state；成功後才verify startup、get_entries、set_steering_mode及prompt(:858)。故此run未到委派prompt步驟；不能從reported零用量保證所有初始化對外I/O都沒有發生。
- RpcPipe:27在request入queue即起30秒timer；寫stdin在:30–33的Promise鏈，並非等ready後計時。accept(:36–44)按id/type/command校驗；目前沒有證據證明此run發生錯誤correlation。
- 宿主main.js:697與:772–774先建立runtime再runRpcMode；rpc-mode.js:289等待bindExtensions/session_start後，:643–650才attach stdin JSONL reader。get_state handler(:345–360)只是回傳session狀態，沒有模型completion呼叫。
- 可能卡點：CLI runtime/extension初始化、session_start hook，以及外部負載拖慢啟動。未保存啟動phase timings／原始wire／CLI invocation/version，無法用這份紀錄確認是哪一個。
- 本地檢查來源為Pi1.0.0；目前安裝目錄另有Pi1.1.0，僅是當前環境事實，不據此倒推本次歷史run使用1.1.0或認定版本造成失敗。D:/GitHub/pi參考路徑不存在，確認可讀來源在D:/GitHub/pi-main/pi-main；使用本地dist與來源交叉核對，不把ffgrep過期路徑誤當檔案證據。

## 隔離驗證進度
- 現存rpc.test.ts完成4/4 passed、0fail／skip；不重播原CLI啟動，僅正常correlation/control/query/capacity契約。
- 第一輪inline probe確認起算30秒與expiry後late reply不復活；正常回覆段工具失敗exit13（unsettled top-level await）。Probe誤以一個Promise microtask即可確認第二次stdin write已完成，回覆了舊command ID；這是實驗腳本的觀察同步錯誤，不當成產品失敗，亦不宣稱該probe完整通過。
- Probe重跑已通過exit0：先訂閱fake stdin write的command事件，等待實際新id，再回覆。已觀察timer在write／ready證據前以30000ms起算；注入deadline callback後獲RPC_DEADLINE，匹配late reply不復活；新的get_state匹配response成功且清除timer。最後dispose pending transport、destroy Writable並還原timer hooks。沒有fixed sleep、真實child／session／provider／磁碟fixture。
- Probe成功輸出（原文，持久證據摘要）：
  ```text
  [verification] Confirmed: startup timer begins before readiness; expired reply stays failed.
  [verification] Confirmed: matching fresh reply succeeds and clears its timer.
  [verification] Fake transport and timer hooks cleaned up; no real provider or session was used.
  ```
- 這只確認目前RPC時序與correlation契約，不重播原CLI初始化；没有確認歷史run确实在30秒後會變ready，亦不能據此排除永久hook卡住或其他環境原因。
- 執行現存rpc.test.ts四個單元案例，使用fake ChildProcess／Writable，不跑真實provider，檢查correlation／容量／control／query契約。
- 再用目前RpcPipe與記憶體fake child、可控setTimeout callback驗證deadline在ready前起算／正常匹配回覆成功／deadline後late response不復活。不是實際等待30秒，也不是重播本次歷史CLI。
- 各one-off命令idle上限20秒、初始化先輸出英文進度；若有工具／環境錯誤據實記錄。不建立產品／測試檔、不讀寫真實設定、不新增child process／憑證使用；mock stdin／pending promise及timer在finally清理。
- 本次既無實作授權，也不自動調大期限或重試任務。原生session維持blocked，不刪除或強制resume。

## 已排除的直接推論
- `No project session found … creating a new session`：符合new run的--session-id行為，不是必須先建立session的錯誤。
- `COMMIT_FAILED`：未完成run／無ready checkpoint的fallback，非已有commit()磁碟寫入失敗證據。
- `hostContract: 0.99.1`：持久格式身份，不表示用了不支援的Pi0.99.1。
- finalResponse空／reported usage0：是未進主task prompt階段的結果，不能說模型已回答失敗或審查发现代码問題。

## 建議下一步（未實作）
1. 加上安全、不含credentials的child CLI實際版本／路徑、spawn／startup guard／RPC ready／first request sent／first response時點及主輸入是否已送出的diagnostics；目前debug log不足以找出初始化哪個phase卡住。
2. 使用隔離home與offline host，對runtime／extension／session_start延遲或卡住作deterministic注入，區分合理冷啟動與真正無回應；保留固定總startup期限，不靠固定sleep或付費provider重播。
3. 若確認合理冷啟動會被共用30秒request預算誤判，再討論獨立startup readiness budget與command response deadline。不要只延長所有RPC請求，不增加盲目重試，也不繞过model/trust/native identity/ownership核實。

## 使用者授權的後續診斷補強
本調查之後，使用者另授權調整訊息以便下次定位原因。已完成英文phase/checkpoint、guard IPC里程碑、RPC write/correlation、child版本／退出與failure/cleanup分離的bounded observations；不更動30秒期限、重試、schema／trust／ownership或原始log/session。Selected驗證通過targeted29/29、root unit10/10 stages（1既有Windows skip不算pass）、Subagents3/3（296 unit＋36offline real-host）、cross3/3及package19/19，Pi1.0.0基準。這不能補回本次歷史缺失的timings，也不改變「本次根因未確定」結論。

後續完整交付：`report/REPORT-20261008T051850208Z-rpc-啟動失敗訊息與診斷補強交付.md`；追蹤：`plan/PLAN-20261008T043521553Z-rpc-啟動失敗訊息與診斷補強.md`。

## 原唯讀調查的驗證覆蓋與限制
唯讀完整指定debug log／manifest／run.json、empty readable transcript／run目錄／native目錄；相關current runner、RpcPipe、child args／guard、session store與Pi1.0.0 host main/RPC局部段落。未完整掃描所有宿主／extensions；沒有讀真實auth內容／修改真實資料。执行rpc.test.ts4/4與in-memory probe；未另跑完整root unit／module／cross／package，因沒有產品或測試程式變更。未重播歷史CLI或真實provider，不宣稱根因已確定或修復。
