# 當前專案穩定性 Code Review 完成報告

2026-10-07 UTC；D:/GitHub/pi-better-tools-main，package0.1.0、適用Pi1.0.0。本次唯讀code review，不含修復。**確認10項：3 High、7 Medium；無已證實Critical。** 另列2項既有／設計風險，不混入新缺陷數量。測試通過不能反證未覆蓋的失效路徑。

## 優先處理的 High

### BUG-006：Schedule 讀取失敗被當成空儲存，下一次新增可毀掉原排程

- **位置**：`modules/schedule-prompt/src/storage.ts:77-99,103-110,164-168`。
- **觸發**：既有檔案讀取EACCES／暫時I/O錯誤，但其目錄仍允許寫入及替換；addJob載入空store後save。Corrupt quarantine rename失敗同樣沒有阻止後續save。
- **影響**：原jobs可無備份被新jobs取代；原子rename只能防半份JSON，不能防錯誤內容完整覆寫。
- **狀態**：已確認／已觀察。`schedule-fault-probe.mjs/.log`用實際CronStorage與isolated temp，只對store read注入EACCES，實際寫入後original `old`消失、只有`new`。未用真排程資料；temp／mock已清理。
- **既有防護／缺口**：已有lock、temp rename、quarantine，但load catch仍回空store，quarantine失敗只log。既有storage測試只檢查成功隔離，不涵蓋read／quarantine失敗後mutation。
- **建議**：只有確定ENOENT可回空store；read failure／無法保留corrupt原檔應fail closed，停止mutation。補故障→add/update不得覆寫與quarantine failure回歸。

### BUG-004：PTY waitFor 的安全正則檢查可繞過，阻塞宿主事件迴圈

- **位置**：`modules/pty-terminal/src/wait-for.ts:7-10`、`pty-manager.ts:331-339`。
- **觸發**：`^(a|aa)+$`通過nested-quantifier heuristic；未讀輸出48個a加!。同步test在deadline／abort檢查前執行。
- **影響**：PTY工具在主Pi行程執行，匹配卡住時其他工具、取消與shutdown回呼都不能前進；256Ki字元window不是CPU時間預算。
- **狀態**：已確認／已觀察actual compileWaitFor＋PtySessionManager.readEx，但用fake PTY在隔離child執行以免凍結主宿主。timeoutMs0仍在regex執行超過1000ms；外部watchdog SIGKILL並等待close。safe `^a+$`控制組約0.26ms返回。沒有宣稱真TUI無限掛死或量測完整最壞時間。
- **證據**：`pty-regex-child.mjs`、`json-schema-regex-probe.mjs ./pty-regex-child.mjs`、`pty-regex-probe.log`。
- **建議**：在可終止worker或等效有界安全匹配器執行；不是再加同一event-loop timer或只列舉更多危險pattern。既有測試只擋(a+)+類，不覆蓋alternation。

### BUG-003：PTY shutdown 未確認終了就丟失本機 transport ownership

- **位置**：`modules/pty-terminal/src/pty-manager.ts:414-427`。
- **觸發**：POSIX child忽略SIGHUP，或backend kill失敗；shutdown只送一次signal、立即偽設exited及clear所有session。
- **影響**：reload後仍存活的本機transport/native resource無法再list/kill，重複reload可累積。不是遠端process-tree是否能停止的明示取捨。
- **狀態**：已確認／靜態可達＋fake backend已觀察ownership遺失；**真POSIX抵抗SIGHUP程序未實測**。本地鎖定`node_modules/node-pty/lib/unixTerminal.js:228-232`只process.kill且吞錯，沒有升級。`pty-state-probe.log`注入kill throw、從未emit exit，仍registry0、waiterexitCode-1、retry unknown session。
- **既有防護／缺口**：正常kill375-397已有等待、SIGKILL升級、確認後release；shutdown未沿用。現有shutdown測試只看waiter/registry，未觀察抵抗signal的真程序。
- **建議**：shutdown await bounded termination／必要升級，誠實保留未確認exit及失敗ownership；各session清理失敗不阻止其他清理。POSIX真程序驗證再認證此修復。

## Medium

### BUG-001：JSON Schema enum／const 合併約束漏驗，無效結果仍被交付

- **位置**：`modules/json-schema/src/schema.ts:63-65,92,106-109`；`extensions/json-schema.ts:129-131,185-188`。
- **觸發**：property `{enum:['a','ab'],minLength:2}`、`{const:'a',minLength:2}`；甚至明列type:string的enum組合。locked zod converter沒有完整套用兄弟約束，而audit未拒絕。
- **影響**：`{x:'a'}`不符minLength卻validate成功。實際extension text fallback已寫出無效result，不能以host json_output參數驗證作反證。
- **狀態／證據**：已確認／已觀察；`json-schema-constraints.mjs/.log`測三組bypass與plain-type拒絕控制組，再用真extension＋fake ctx、activeTools空、零provider請求，驗證result檔內容。temp已清理。
- **建議**：startup拒絕不能忠實驗證的交集，或補足相交約束；測enum/const+type-specific bounds，而不是只測各自keyword。

### BUG-002：JSON Schema pattern 同步驗證沒有可中斷預算

- **位置**：`modules/json-schema/src/schema.ts:106-107`（locked zod converter直接new RegExp）。
- **觸發／影響**：使用者選用`(a+)+$`，模型結果32個a加!，同步safeParse阻塞print CLI；60秒fallback AbortSignal無法中斷此同步CPU。
- **狀態／證據**：已確認／已觀察；`json-schema-regex-child.mjs`、共用probe與`.log`。Node26.8.1、無NODE_OPTIONS；safe約0.8ms，unsafe1秒未返回、owned child外部kill/close。未量測完整最壞時間。因feature為opt-in print-only且pattern由使用者選用，評Medium，與全宿主PTY High不同。
- **建議**：可終止worker或等效安全pattern策略，含propertyNames/patternProperties適用約束；不要宣稱AbortSignal能取消正在跑的RegExp。

### BUG-005：PTY raw 預設模式遇超大單一CSI，游標永久零進度

- **位置**：`modules/pty-terminal/src/output.ts:112-115`、`src/index.ts:51-53`。
- **觸發**：ESC[＋`0;`重複30000次＋mTAIL，完整CSI超50KiB；每次截斷停在0。
- **影響**：反覆read皆只truncation提示、後方TAIL不可取得；2Mi ring上限不能修掉每次零進度。format:text可繞過。
- **狀態／證據**：已確認／已觀察；`pty-state-probe.mjs/.log`兩次actual manager/truncator consume cursor皆0、remainder60007不變、TAIL不可見；text控制组取到TAIL，無真PTY資源。
- **建議**：對超額escape採明示丟棄／有界處理策略以保證cursor進度，並測完整／未完整巨大CSI與續讀。

### BUG-007：Schedule 關閉前的儲存清理失敗會跳過 scheduler teardown

- **位置**：`modules/schedule-prompt/src/index.ts:102-104`（非startup session_start95-99也有同序列）。
- **觸發**：disabled job自動刪除時save/rename重試耗盡而throw，沒有finally，cleanupSession根本不執行。
- **影響**：reload/關閉留下舊timer／in-process run；SDK捕捉hook錯誤不補跑該extension清理。
- **狀態／證據**：已確認／actualhook＋受控fault已觀察；`schedule-fault-probe.log`stopCalls0，恢復storage再shutdown才stop1。沒有真模型或長timer殘留測試。
- **建議**：scheduler teardown置finally且先封閉新派發；storage掃描是best effort，不可阻止必要資源釋放。

### BUG-008：Schedule cron「驗證」建立未納管 timer

- **位置**：`modules/schedule-prompt/src/scheduler.ts:612`。
- **觸發**：new Cron(expression, callback)在有效驗證時排timer，臨時instance未保存或stop；add/update/UI反覆驗證可累積，後續deadline拒絕也留timer。
- **影響**：空callback timer與closure留在event loop，scheduler.stop無法清理；不是使用者真正建立的排程。
- **狀態／證據**：已確認／actualCroner已觀察；`schedule-fault-probe.log`驗證一個expression建立1個30,000ms timer，由實驗observer代為clear。不是產品清理。既有驗證測試只看valid boolean。
- **建議**：使用不啟動任務的純parse驗證或立即stop臨時instance；測所有validator成功/拒絕路徑的timer ownership。

### BUG-009：Subagents prompt 暫存／清理 I/O 未經取消與期限 gate

- **位置**：`modules/subagents/extensions/subagent/index.ts:259-270,538-541,932`。
- **觸發**：mkdtemp／prompt/task write或cleanup rm在檔案系統持續不settle；直接await沒有IoGate，startup abort只stop gate，而child inactivity timer尚未建立。
- **影響**：runner不返回，8 active permits與submitted budget無法釋放；bounded background shutdown雖可返回，舊awaiter仍卡住。正常立即throw測試不能反證無settlement路径。
- **狀態**：已確認／完整靜態可達；沒有注入真OS永不返回filesystem實驗，不稱observed。helper與callsite主審已逐段讀取確認無另一層timeout。
- **建議**：接入既有IoGate/cancel與late-operation cleanup所有權；用controlled deferred驗取消先返回、晚到檔案不遺留，不用固定sleep或擴大timeout。

### BUG-010：Subagents detached query 複本永遠cleanupPending，誤擋健康 sibling

- **位置**：`modules/subagents/extensions/subagent/background.ts:153-154,190,195-197`；`rpc.ts:147-160,192-195`。
- **觸發**：runner abandonment時finish保存query snapshot並刪handle；之後真child close/terminal IPC更新RpcInteraction但不更新task複本。兩筆stalecleanupPending仍佔job query budget。
- **影響**：status cleanup／late usage永久過時，parallel內健康sibling即使實際query lease釋放仍QUERY_CAPACITY。
- **狀態／證據**：已確認／actualclasses＋fakeIPC已觀察；`subagent-detached-query-probe.mjs/.log`實際handle兩筆false、registry仍true，健康sibling被拒；deferred/streams/query timers/registry清理，沒有provider。既有rpc-abandon只看handle，不看registry一致性。
- **建議**：late terminal notice以queryId更新bounded detached receipt及usage/cleanup，保留原failed/aborted outcome，不誤把provider已停當成成功；通知/狀態/容量同源。

## 既有取捨／設計風險，不列新BUG

- **RISK-002／High impact，既有契約**：Schedule `storage.ts:61-62`普通mutation拿不到lock仍讀改寫；A持鎖讀後停頓、B逾時fallback寫、A恢復可覆蓋B。`stability-storage.test.ts:61-68`明確保留，不等於沒有資料風險。endAt新requireLock只限expiration。建議使用者若需跨session共享一致性，另授權改fail-closed/locking契約；本次不偷偷修改。
- **RISK-001／Medium，設計風險、未實測SDK積壓**：Schedule inline每秒followUp沒有去重／容量／backpressure，慢主agent可能排隊累積；4 parallel cap只保護model subagents。這與明確排程「每tick都派發」語意相關，需定義合併/skip/拒絕策略，不冒稱已觀察記憶體耗盡。

## 覆蓋、驗證與界線

- 主審File Tools全部operations（1518行）、worker/runner、path/skill/log/errors/debug及extension，JSON全部實作，GPT/Note實作及README/相關tests。三獨立子審追蹤Subagents runner/RPC/managed store、Shell/PTY/shared bottom panel、Web/browser與Schedule/storage/deadline。重點路徑審查，不代表每條分支均認證。
- Web、Shell、File、Note、GPT與shared panel在已查範圍未新增確認缺陷。明示外部writerTOCTOU、遠端process-tree不保證、持久資料保留、敏感command/title不redact、舊mouse警告不重算。
- 本次執行GPT/JSON/Note既有pure tests **77/77、零skip**，含JSON16/GPT39/Note22；證據`existing-pure-tests.log`。6類隔離probe（schema交集、schema regex、PTYstate/raw、Schedulefaults、PTYregex、detached query）均按reproduction斷言成功；不是修復後回歸全通。
- **未執行**根npm test/typecheck、全模組integration、cross、package、build/browser/check；唯讀review沒有重新宣稱上一任務驗證。未實測POSIX SIGHUP抗拒程序／真OS filesystem stall、真人TUI/滑鼠、WSL/SSH、真provider/backend、長程/高負載/跨平台。
- 兩個regex hazard用owned child bounded1秒、startup20秒、逐一執行，SIGKILL後close已確認；safe控制組正常close。其他probefake transport、mock只限isolated temp／自身prototypes並finally還原，temp/stream/timer均清理。無真credential/settings/auth/schedules變更、無paid backend請求、無commit/publish。
- 三子審未提供note能力，詳細結論由主審取final transcript保存為task evidence；task_result表面只含progress，未當審查結論。其回傳缺漏另屬待定位工具傳輸現象，本次未新增未證實產品BUG。

## 記錄與重播

來源86檔SHA256 baseline與final比對**0變更**、無Git。所有evidence根：`plan/evidence/review-20261007T053926Z/`；內有上述scripts/logs、`source-baseline.json`、`source-baseline-final.json`及三份`*-review.json`。

逐批紀錄：
- `research/RESEARCH-20261007T054423265Z-主審穩定性審查進度-file-json-note-gpt.md`
- `research/RESEARCH-20261007T055359182Z-三份獨立穩定性子審核對與驗證進度.md`
- `plan/PLAN-20261007T053926327Z-當前專案穩定性-code-review.md`

建議修復順序：BUG-006儲存fail-closed → BUG-004 regex可終止 → BUG-003 PTYshutdown ownership → BUG-007/008 lifecycle/timer → 其他資料驗證/receipt/cancel/drain問題。**本次只審查與驗證，沒有修復產品。**
