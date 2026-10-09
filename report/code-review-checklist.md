# 各模組 Code Review Checklist

- 日期：2026-10-08
- 方式：每個模組由獨立唯讀 agent 讀碼審查。
- **原審查狀態**：每項曾由第二輪獨立 agent 讀碼查證（當時未重現、未執行測試）。本次已逐模組讀碼、修補／補強並執行回歸；現況以以下「逐項處置」為準。原始發現／行號保留作歷史追溯，不表示修補後仍然存在。不成立的項目（L31）已刪除並保留理由。
- 查證結果：原 54 項中，43 項成立、10 項部分成立（MH1、MH2、M10、M13、M15、L3、L7、L8、L11、L21）、1 項不成立（L31，已刪除）；現存 53 項。H2、L11、L12、L13 另標註為已文件化的設計取捨或已知限制。
- 修補約束：保留工具名／schema／儲存格式／trust 語意；檔案維持 LF；schedule-prompt 為第三方快照，修改須記入 `docs/adaptations.json` 並更新 provenance 雜湊。
- 驗證分組：單一模組用 `npm run test:module -- <module>`；動到 `docs/*.json`、`scripts/`、多模組時加跑 `npm run test:cross`。

## 逐項處置（2026-10-08）

- **38 項修復／既有修補查證、5 項部分修復、5 項政策待決、5 項有理由保留。** M4 曾因 close-rejection 缺口重新開啟，後續 rejecting close barrier、一般／晚到 lock retention 與故障注入已補齊；2026-10-08 第一階段獨立查證確認追蹤狀態過期，現恢復完成。這不代表另一筆 `writer.lock` EPERM／ENOTEMPTY 清理問題已根治。勾選只表示該項修復／查證完成；部分、待決與保留不勾成已根治。
- 「既有」表示修補在本次工作開始前已存在，不能算成本次新增；「補強」表示本次補足邊界或生命週期。九個模組分組皆有最終通過紀錄（已知 skip 另列、不算測試通過）；Web 最後的 worker capacity 補強亦已完成 4/4 stages 重驗。
- 工作目錄沒有 `.git`；以 SHA-256 inventory 追蹤修改，不宣稱已提交。原修補快照的76個 reviewed snapshots／51個既有 mismatch保留於原報告，不當作目前數量；第一階段開始前 provenance 通過195個 local snapshots、104個 adaptations、103個 added files、28個 native files，43個歷史不足警告保留。此次760-file基準：`plan/evidence/unresolved-phase1/baseline.json`；immutable sources/originalSha256不改。

| ID | 處置 | 已做／保留理由 |
|---|---|---|
| H1 | 已修復（既有＋查證） | 忽略模型 confirmProjectAgents；未信任 project 有UI必確認、無UI拒絕，schema與trust保留。 |
| H2 | 部分修復，未根治 | 每跳 serverAddr 事後檢查已存在並補真實回歸；原始HTTP request仍可能送到私有端，不能阻止 blind SSRF。需出口filter/proxy或受控transport重設計。 |
| MH1 | 政策待決 | 保留 Pi 開頭@慣例；建立字面新檔使用 `./@types/foo.d.ts` 或絕對路徑，補實際write回歸。偏離慣例需使用者決定。 |
| MH2 | 已修復（補強） | worker失敗後所有新輸出都合併50ms重試；總期限到達不再啟動worker，保留abort/exit/unread語意。 |
| M1 | 已修復（既有＋回歸） | abandon不假釋child permit/writer lock；destroy管道，實際close才釋放；八個kill-failed children回歸。 |
| M2 | 已修復（既有＋回歸） | readable transcript finish已用renameWithRetry；真實writer注入EBUSY端到端驗證。 |
| M3 | 已修復（既有＋查證） | POSIX detached/process-group signal，Windows保留taskkill /T；未在真實POSIX驗證整棵樹，不保證逃離group descendants。 |
| M4 | 已修復（補強＋後續查證） | actual-idle／跨loader live nonce及rejecting writer close barrier已補；normal／write-failure／late／late-create故障注入保留close失敗的ownership，一般／晚到收尾不假釋lock。後續選定驗證與current獨立查證見M4 issue及 `report/REPORT-20261008T075605060Z.md`；EPERM／ENOTEMPTY另案仍未根治。 |
| M5 | 已修復 | once fire=false明確停用/error、清nextRun/timers，不延遲重送；peer removed/disabled/expired狀態不覆寫。 |
| M6 | 已修復（既有＋節流） | render使用snapshot，change burst 100ms coalescing，hide/destroy取消refresh；deferred error不逃出timer。 |
| M7 | 已修復 | 所有mutation/corrupt recovery須取得owner-token鎖；不按age偷鎖、不無鎖寫入，contention立即拒絕；crash lock需人工確認後清理。 |
| M8 | 已修復（補強） | 逐則保存被抑制的原始assistant content，在副本回填；避免文字重複／區塊重排，宿主訊息不變。 |
| M9 | 已修復（既有＋回歸） | 逐候選schema驗證，取第一個有效值；前置空物件／陣列不阻擋有效JSON，不必直接付費抽取。 |
| M10 | 部分修復 | 短temp name、數秒Windows backoff已存在，補每次retry的hash/stat/cancel回歸；原子rename仍不保證ACL／硬連結身份保留。 |
| M11 | 政策待決 | 保留diff timeout不提交；新增確定性回歸證明檔案不變。改成timeout後成功提交或另算startup需明確新契約。 |
| M12 | 已修復（既有＋補強） | JSDOM worker隔離；補listener/ref/byte-precheck與有界active+retiring ownership/shutdown。終止要求不當成已退出。 |
| M13 | 已修復（既有＋回歸） | image/stylesheet/media/font在送request前阻擋，SPA/hydration仍通過；無content-length回應的transfer/peak memory cap不誇大。 |
| M14 | 已修復（補強） | ready receipt後才計compute budget，startup最多5秒；16-worker permit確認termination才釋放。 |
| M15 | 已修復（既有＋回歸） | 單趟 `\\` 與 `\x5c` 字面跳脫；補description及shield/連續/尾端反斜線測試，不二次解碼。 |
| M16 | 已修復（既有＋補強） | realpath target、lock retry、鎖內mode/chmod；EACCES/dangling symlink fail closed，不破壞既有symlink。 |
| L1 | 保留（非安全小改） | spool await是明示背壓與ack落盤策略；延遲put需bounded cache/spill/ack與取消時序重設計，不能直接移除await。 |
| L2 | 保留（完整性優先） | 不同交易時點的checkpoint/hash/容量掃描不能以stat cache取代；沒有保持同等防護的可量測最小優化。 |
| L3 | 已修復（既有＋查證） | stdout parser依新fragment累計UTF-8 bytes，newline重設；不重掃整段，8MiB上限保留。 |
| L4 | 已修復（既有＋回歸） | assistant output 2MiB與alias/key帳目8MiB分離；7500 canonical tool結果回歸完成。 |
| L5 | 部分修復 | 每次rename/retry前完整hash後再stat/cancel；縮小TOCTOU，但stat與rename仍非單一OS操作，不宣稱根治。 |
| L6 | 已修復 | 每次edit lazy重用RegexSession worker/相同搜尋字串；scope變動保持anchor/template語意，finally確認終止且不跨edit保留全文。 |
| L7 | 保留（原建議不安全） | 保留提交前完整重讀／SHA-256；stat是額外fence，不取代hash。64字元hash前32相同仍拒絕回歸通過。 |
| L8 | 部分修復 | payload／深度循環／字串edits／rangePreview／regex診斷只記length/hash；日誌retention不變，不冒稱通用secrets DLP。 |
| L9 | 已修復（既有＋回歸） | unreadable/invalid設定降級false＋警告；補EACCES fault injection，缺檔安靜false。 |
| L10 | 已修復（既有＋查證） | 每次fetch hostname→Promise DNS memo，含失敗；不同fetch不共用，peer每回應仍檢查，cache不是IP pinning。 |
| L11 | 政策待決 | 保留blocked主導覽fail-closed、子資源warning；新增JS導向回歸，不回傳stale document。 |
| L12 | 政策待決 | 全文temp保留供後續read；補service.close後仍可讀回歸。若改TTL／數量／shutdown清理，需先定fullOutputPath可讀期限。 |
| L13 | 政策待決 | 保留context.close最多等5秒後釋slot、browser cleanup後續處理；hung close仍可能留context，改政策需評估其他fetch取消。 |
| L14 | 已修復（既有＋查證） | getNextRun支援cron/interval/once與knownJob，保留deadline與停止清理。 |
| L15 | 已修復（補強） | 驗證consumer必要／optional shape，忽略malformed job＋diagnostic；v1 legacy缺stats保留，invalid endAt由scheduler fail-closed。 |
| L16 | 已修復（補強） | corrupt recovery鎖內重新read/parse，避免quarantine peer新有效檔；pid/random backup，假ENOENT/source仍在時拒絕。 |
| L17 | 已修復（既有＋查證） | inline/model完成在同一locked fresh read-modify-write加count；兩個storage interleave確認不漏算。 |
| L18 | 已修復（補強） | reset只匹配truthy own session，foreign/unbound與未取得session id不清除；相同session跨process distributed owner仍不保證。 |
| L19 | 部分修復／政策保留 | 超大relative明確拒絕與界限已修；+0s拒絕、date-only UTC、無zone datetime local為文件化政策，不擅改。 |
| L20 | 已修復（補強） | text/details/structuredContent只回單一relativePath，outputSchema一致；actual loader/renderer fixtures亦同步。 |
| L21 | 已修復（後續命名契約取代） | 原快照曾以lazy heading掃描補強；目前依使用者要求採timestamp-only、不附heading／slug，execute已移除deriveSlug，完整note仍原樣寫入。本輪不重做既有命名修正。 |
| L22 | 已修復（後續命名契約取代） | 原快照的fence-aware heading回歸保留作歷史；目前filename不從content擷取heading，code heading已不影響命名。TUI有界預覽不決定存檔名稱。 |
| L23 | 保留（影響可忽略） | 有意collision策略最多偏晚999ms，排他建立不覆寫；檔名時間戳不當精確write-time證明。 |
| L24 | 已修復 | 滿載只reclaim輸出/drop通知已讀的exited session，否則拒絕spawn；drain/explicit release後可再admit，既有10min retention保留。 |
| L25 | 已修復（既有＋回歸） | buffer overflow一次修剪至15/16 slack，非每chunk複製約2MiB；小chunk/cursor/drop回歸。 |
| L26 | 已修復（既有＋回歸） | exited write明確拒絕，backend不收到輸入，unread最終輸出仍可讀。 |
| L27 | 已修復（既有＋補強） | pause在exit喚醒，已退出在配置timer/listener前短路。 |
| L28 | 已修復（既有＋查證） | 目錄刪除重試與first-submit dead-owner/old-unmarked sweep；存活owner/self/skip/非一般目錄不刪。 |
| L29 | 已修復（既有文件化） | schema/guideline/README明示launch前計時與首次輸出startup成本，保留原idle語意。 |
| L30 | 保留（安全＋影響可忽略） | per-chunk owner/generation fence阻止disposed session繼續輸出／通知，不能為微小開銷移除。 |
| L32 | 已修復 | reusable validation pool：4 worker/256 queued FIFO、cancel/ready budget、last-schema cache；確認terminate/exit才釋容量。 |
| L33 | 已修復（既有＋回歸） | Windows delivery rename bounded retry涵蓋EPERM/EBUSY/EACCES，保留原檔/cleanup；確定性成功/耗盡/非transient回歸。 |
| L34 | 已修復（既有＋查證） | directTests空檔清單throw，不讓node --test默掃；空readdir的實際函式注入驗證。 |

### 驗證與紀錄

- 後續M4／第一階段追蹤：`report/REPORT-20261008T075605060Z.md`、`plan/PLAN-20261008T075046931Z.md`。本輪新摘要／teardown／通知改動尚在進行，以下為原快照的驗證，不能當本輪最終結果。
- 不在原53項內的新追蹤：EPERM／ENOTEMPTY根因、SA-AUDIT-002通知可觀測性與SA-AUDIT-003摘要；歷史RPC startup根因也仍未知。分開記錄，不以M4恢復勾選將它們關閉。
- 最終總報告：`report/REPORT-20261008T020215870Z-code-review-checklist-逐項處置與最終驗證.md`。
- 已執行：九個 `test:module` 分組、`npm test`（10/10 stages）、`npm run typecheck`（9/9 stages）、`test:cross`（3/3 stages）、`test:package`（19/19 stages，實際tarball＋clean Pi1.0.0 production install/tree/native setup、PTY/JSON/Web protocols、loader modes、managed child與cleanup）、build（刻意no-op）、`sources:verify`（通過且保留歷史warning）。Web最終分組包含70unit、14real-browser與2composition。File有1個Windows POSIX-path skip，PTY integration有1個POSIX-signal skip，均不當pass；早期失敗與重跑原因保留於各報告。
- 未另外重跑全組 `test:integration`／完整`check`：各module＋cross已包含對應host/整合項目，避免重複；人工TUI、真實provider、WSL/SSH與真實POSIX signal tree未驗證。
- 詳細逐模組報告：`report/REPORT-20261008T015422424Z-subagents-checklist-修補與既有修補驗證.md`、`REPORT-20261008T014844780Z-file-tools-checklist-修補與驗證報告.md`、`REPORT-20261008T014745109Z-web-tools-checklist-修補與現況驗證.md`、`REPORT-20261008T014742245Z-schedule-prompt-checklist-修補與現況驗證.md`、`REPORT-20261008T014456359Z-pty-checklist-修補與驗證報告.md`、`REPORT-20261008T015010367Z-json-schema-checklist-修補與回歸驗證-m8-m9-l32.md`、`REPORT-20261008T014246317Z-note-tools-gpt-speed-審查修補結果-m16-l20-l23.md`。

## 高

- [x] **H1 subagents：專案層 agent 核准可被模型關閉**（`extensions/subagent/index.ts:1248-1249`、`:998`）
  - 核准條件含模型可傳的 `confirmProjectAgents`；`hasUI=false` 時也直接略過，未信任 repo 的 `.pi/agents/*.md` 可被執行。違反 trust 不變量。
  - 修法：忽略模型傳入值（或只允許設為 true）；未信任且無 UI 時對 `source==="project"` 一律拒絕。
- [ ] **H2 web-tools：DNS rebinding TOCTOU**（`src/fetch/service.ts:211,222,227`、`network.ts:54`）〔已成立；程式註解 `network.ts:6-7`、`service.ts:83` 已自承為 defense in depth、非 sandbox，屬已記錄的已知限制〕
  - `dns.lookup` 驗證與 `route.fetch` 實際連線各自解析，未釘住 IP，可繞過私有位址封鎖。
  - 修法：連線時驗證實際 IP（undici `connect.lookup`），或走出口過濾 proxy。

## 中高

- [ ] **MH1 file-tools：新檔路徑開頭 `@` 被剝除**（`src/path-utils.ts:28,42-46`）〔部分成立〕
  - 字面路徑已存在時會優先採用（`path-image-regressions.test.ts:60` 涵蓋 `@scope`）；只有字面路徑不存在的新檔會被改寫，`write @types/foo.d.ts` 在 `@types` 不存在時會建出 `types/`。
  - 屬刻意沿用 Pi 的 `@` 路徑慣例的風險，非單純 bug；修法會與該慣例衝突，需先決定是否偏離。
  - 可行修法：改查字面路徑的父目錄是否存在。
- [x] **MH2 pty-terminal：`waitFor` 持續輸出時連續起 worker**（`src/pty-manager.ts:343-365`，`matcher.ts`）〔部分成立〕
  - 比對失敗且 buffer 又有新輸出時不節流地重起 worker 並重掃最多 256KB。
  - 受 worker 啟動成本與 `active<16` 自然限速，並非無界熱迴圈；嚴重度原報告略誇大。
  - 修法：加 50–100ms debounce，或只比對新增片段並保留重疊字元。

## 中

- [x] **M1 subagents：abandon 路徑在 child 可能仍存活時釋放 lock 與 permit**（`index.ts:574-580,911-918,344-348`）〔成立，邊角情境：需 taskkill／SIGKILL 失敗才觸發〕
  - Windows taskkill 失敗時，同一 session 可被 resume 成兩個 child 同時寫入，活動 child 也可能超過 8。
  - 修法：`!childGone` 時保留 permit 與 lock；abandon 時 destroy 管道。
- [x] **M2 subagents：可讀 transcript rename 沒有重試**（`subsession-log.ts:466`）
  - Windows 暫時鎖定會讓成功的 run 變成 `COMMIT_FAILED` 並 rollback。
  - 修法：改用 `session-store.ts:116` 的 `renameWithRetry`。
- [x] **M3 subagents：POSIX 只殺直接 child**（`concurrency.ts:47`、`index.ts:539`）
  - 無 process group，孫行程成孤兒。
  - 修法：`detached:true` 加 `process.kill(-pid, sig)`。
- [x] **M4 subagents：同 pid 的 lock 永不判定 stale**（`session-store.ts:271`、`index.ts:911`）
  - 該 session 在本行程內永遠 `SESSION_BUSY`，要重啟 Pi 才恢復。
  - 修法：行程內登記 lock nonce，late I/O 完成後補 release。
- [x] **M5 schedule-prompt：once 任務被略過後永久遺失**（`src/scheduler.ts:215-231`）
  - `fire()` 回傳 false（4 個 subagent 滿載、前次仍在跑、內聯例外）時不重排也不停用，仍為 `enabled:true`。
  - 修法：明確停用並標 error，或有上限地短延遲重試。
- [x] **M6 schedule-prompt：widget render 同步磁碟 I/O**（`src/ui/cron-widget.ts:113-114,175`）
  - 每次 render 讀檔一次，另對 cron 型 job 各再讀一次（N 僅限 cron 型）；`show()` 也再讀一次，並有 30 秒 refresh 與每次 `cron:change` 觸發。
  - 修法：改用記憶體快取或 mtime 快取，並限制最小間隔。
- [x] **M7 schedule-prompt：lock stale 偷取有競態，逾時後無鎖寫入**（`src/storage.ts:45-62`）
  - 兩行程同時持鎖造成 lost update；`sleepSync` 最多阻塞 2 秒。
  - 修法：鎖內寫 owner token，只刪自己的鎖，或用 `rename` 原子接管。
- [x] **M8 json-schema：fallback transcript 缺最後一則助理文字**（`json-schema.ts:105-141`）
  - `message_end` 已去除 text，`recover()` 抽取無內容可用。
  - 修法：`message_end` 時另存完整文字並補回 transcript，或不改寫訊息。
- [x] **M9 json-schema：`extractJson` 只回傳第一個可 parse 的候選**（`extract.ts:36-50`、`:130-131`）
  - 前面出現 `{}` 或 `[1]` 時驗證失敗，改走付費抽取或直接失敗。
  - 修法：回傳所有候選並依序驗證。
- [ ] **M10 file-tools：Windows 原子寫入缺陷**（`src/file-operations.ts:901-996`）〔部分成立〕
  - 成立：rename 僅重試 5 次（20/40/60/80ms，約 200ms，只處理 EPERM／EBUSY）；暫存檔名含完整檔名且多約 50 字元，檔名超過約 205 字元會 `ENAMETOOLONG`；rename 新檔會丟失硬連結與 ACL。
  - 不成立／高估：「非原子 fallback」只發生在新檔建立且 `link()` 失敗時（`:979-996`），用排他建立，不會覆蓋既有檔。
  - 修法：短暫存檔名；Windows 重試 backoff 到數秒。
- [ ] **M11 file-tools：diff 逾時讓整個 edit 失敗**（`diff-runner.ts:6,147,235`、`file-operations.ts:1427`）〔成立；「逾時不寫入」是明確設計，錯誤訊息寫 "no edit was committed"，改動前需確認測試是否鎖定；`computeDiffWindow` 已降低觸發機率〕
  - 2 秒上限含 worker 啟動，且在寫入前執行。
  - 修法：逾時降級為簡易 diff，不阻擋寫入；或從 worker started 後才計時。
- [x] **M12 web-tools：渲染後 HTML 同步 JSDOM 解析卡事件迴圈**（`src/fetch/extract.ts:52,72`）
  - 最大 5 MiB，期間 TUI／abort 凍結，`timeoutMs` 無法中斷。
  - 修法：移到可 terminate 的 worker thread，或降低上限。
- [x] **M13 web-tools：不必要的子資源下載與緩衝**（`service.ts:207,261-264`）〔部分成立〕
  - 成立：`image`／`stylesheet` 未攔截。
  - 修正：body 讀取前已先用 `exceedsResponseLimit(headers)`（`:253`）檢查 content-length，10 MiB 檢查延後只對沒有 content-length 的回應成立。
  - 修法：一併 abort `image`、`stylesheet`（必要時 `ping`、`beacon`）。
- [x] **M14 pty-terminal：worker 啟動時間計入比對預算**（`pty-manager.ts:349-355`、`matcher.ts`）
  - 小 `timeoutMs` 時誤報 timeout。
  - 修法：從 worker ready 才開始計預算，或加啟動容許量。
- [x] **M15 pty-terminal：沒有 `\\` 跳脫，tool description 未說明替代寫法**（`src/escape.ts:4`、`index.ts:84`）〔部分成立〕
  - `C:\new\temp` 會被轉成換行／tab；但 `\x5c` 可解出字面反斜線（單趟替換，不會二次解碼），例如 `C:\x5cnew\x5ctemp`，因此並非「無法送出」。
  - 修法：支援 `\\` 並更新 tool description，或在 description 說明 `\x5c`，或加 `raw:true`。
- [x] **M16 gpt-speed：settings.json 以 rename 覆蓋**（`extensions/gpt-speed.ts:49-62`）
  - 破壞 symlink、固定 0o600 取代原權限；單次 `lockSync` 無 retry（host 的 settings-manager 有 10 次×20ms），ELOCKED 時設定存不下來（`:103-104` 會 catch 並 warn，不會崩潰）。
  - 修法：先 `realpathSync`，沿用原 mode，加 retry。

## 低

### subagents
- [ ] L1 每個 tool 結果都寫 spool，在 stdout pump 內 await（`index.ts:481,708`、`tool-result-spool.ts:196-211`）：改延遲寫入。
- [ ] L2 大型 native session 重複全檔雜湊、`diskUsage` 多次遍歷（`session-store.ts:172-227`）。
- [x] L3 單一大 record stdout 緩衝為 O(n²)（`protocol.ts:46`）：改累計位元組計數器。〔部分成立：record 上限 8 MiB、chunk 64 KiB，約 128 次掃描，實際為亞秒級，影響被高估〕
- [x] L4 約 7k 次 tool call 後觸發 "retained message memory exceeded"（`index.ts:409,451,459`）：alias／key 帳目與輸出預算分開。

### file-tools
- [ ] L5 驗證到 rename 之間有競態窗口（`file-operations.ts:961-964`）：rename 前比對 mtime／size／ino。
- [x] L6 每個 regex edit 新建 Worker 並複製全文（`:405-414`、`:1183`）：重用 worker。
- [ ] L7 每次寫入重讀並重新雜湊（`:856,1395`）〔部分成立：重讀兩次屬實，但提交前的重讀正是 stale 防護；改成只比對 `stat` 會削弱保障（mtime 解析度、同大小改寫），**不建議照原建議修**，僅可考慮其他優化〕
- [ ] L8 `debugLog` 開啟時，失敗請求的紀錄含 write／edit 全文且無保留期限（`debug-logging.ts:57-65`）：只記長度與 hash。〔部分成立：`debugLog` 預設 false、只記「失敗」（`:101,:124`）；檔案 0600、目錄 0700，影響有限〕
- [x] L9 settings.json 無效或 EACCES 時 extension 載入失敗（`debug-logging.ts:17-44`、`extensions/file-tools.ts:432`）：降級為 `debugLog:false` 並警告。〔成立；`debug-logging.test.ts:46-49` 鎖定「無效值要 throw」，修法需連同調整測試〕

### web-tools
- [x] L10 每個子資源重新 `dns.lookup`（`service.ts:211`）：單次 fetch 內快取，可與 H2 一併處理。
- [ ] L11 頁面 JS 導向被擋 URL 讓整次 fetch 失敗（`service.ts:197-198,301`）。〔部分成立：這是 fail-closed 行為，屬設計取捨；被擋的子資源只產生 warning〕
- [ ] L12 輸出超過 24 KiB 的暫存目錄不清理（`src/output.ts:28`）：shutdown 時刪除或限制數量。〔成立；`README.md:134` 已明寫暫存檔不會在 shutdown 時刪除，屬已文件化行為〕
- [ ] L13 context 關閉逾時後 slot 提前釋放（`service.ts:328-331`）。〔成立；程式註解稱為刻意取捨〕

### schedule-prompt
- [x] L14 `getNextRun` 只認 cron（`scheduler.ts:141-153`）。
- [x] L15 `load()` 不驗證每個 job 元素，null 元素使每次操作 TypeError（`storage.ts:93`）。
- [x] L16 儲存檔損毀時兩行程競態 `quarantineCorruptStore`，`session_start` 失敗（`storage.ts:104`、`index.ts:57`）。
- [x] L17 `runCount` 兩段式更新，跨行程少算（`scheduler.ts:397-405,514-521`）。
- [x] L18 `start()` 清除他人的 `lastStatus:"running"`（`scheduler.ts:64`）。〔成立，範圍更大：`isLoadedFor` 含無 `session` 欄位（unbound）的 job，另一行程正在執行的 unbound job 也會被清掉〕
- [ ] L19 `+0s` 被立刻停用並標 error；超大相對時間 RangeError 含糊；純日期被當 UTC（`scheduler.ts:627-644,176-189`）。

### note-tools
- [x] L20 `details`／`structuredContent` 帶絕對路徑，違反「單一相對路徑」（`extensions/note.ts:117-121,53-57,67-70`）：只留 `relativePath` 並更新測試。
- [x] L21 `deriveSlug` 的 `lines.map(regex).find(...)` 對全部行（上限 8MB）eager 跑 regex（`:26`）。〔部分成立：normalize 只處理選中的那一行（`:28`），不是逐行 normalize，影響很小〕
- [x] L22 標題偵測不分 fenced code block（`:26`）。
- [ ] L23 時間戳碰撞用 `Date.now()+attempt`，最多偏晚不到 1 秒（`:93-95`）。〔成立但極輕微：僅碰撞時發生，非 bug，可忽略〕

### pty-terminal
- [x] L24 滿載 `reclaim(true)` 靜默丟棄已結束但未讀的輸出（`pty-manager.ts:195-198`）。
- [x] L25 buffer 滿載後每個 chunk 複製約 2MB（`:255-260`）。
- [x] L26 `pty_write` 未檢查 session 狀態（`:249`）。
- [x] L27 `pause()` 在 process 結束時不提早返回，與註解不符（`:340`）。

### shell-tools
- [x] L28 Windows shutdown 時 `rmSync` 失敗被吞，`pi-shell-job-*` 殘留（`src/background-jobs.ts:344,135`）：加重試並於下次啟動清理。
- [x] L29 idle timer 在行程啟動前計時，小 `timeoutMs` 可能誤殺（`extensions/timeout-ms.ts:65`）：在 description 註明或放寬首個 chunk。
- [ ] L30 每個 `onData` chunk 呼叫 `isCurrent()`（`background-jobs.ts:161`）：開銷很小。

### json-schema
- [x] L32 含 `pattern` 的 schema 每次驗證新建 Worker 並重載 zod；超過 4 個並行直接失敗而非排隊（`schema.ts:112,127`）。
- [x] L33 `writeJsonFile` 在 Windows 上 rename 無重試（`delivery.ts:7-17`）。

### scripts
- [x] L34 `run-checks.mjs:13,17,25` 篩選後檔案清單為空時，`node --test` 會掃描預設目錄：加空清單防護。〔成立但屬預防性：目前所有呼叫的目錄都有檔案，不會觸發〕

## 已刪除（查證後不成立）

- ~~L31 gpt-speed：`before_provider_request` 對 compaction 等其他 model 請求誤加 `service_tier`~~：host 的 `onPayload` 只掛在 agent 主迴圈的 stream options（`sdk.js:262`），compaction 走 `compaction.js:487` 的 `completeSimple`／`streamFn`，不帶 `onPayload`，不會觸發 `before_provider_request`；主迴圈請求的 model 即 `ctx.model`。僅剩 turn 中途切換 model 的極端競態，不列入。

## 審查後確認無問題

- web-tools：IPv6／IPv4-mapped／十進位與十六進位 IPv4 無繞過；重導向逐跳驗證正確。
- note-tools：無 path traversal 或覆寫漏洞。
- shell-tools：idle timeout、job 狀態機、SSH／WSL quoting、env 過濾。
- subagents：Semaphore、RPC 背壓、`--exclude-tools subagent` argument builder、child-guard。
- file-tools：CRLF 偏移、BOM、UTF-16 孤立代理檢查、symlink 拒絕。
- schedule-prompt：計時器清理、2^31 毫秒上限、DST。
- scripts：`verify-sources.mjs`。
