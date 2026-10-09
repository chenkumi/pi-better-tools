# File-tools checklist 修補與驗證報告

- 日期：2026-10-08
- 任務範圍：僅 `modules/file-tools/**`；本報告依委派要求由原生 `note` 另存。
- 審查 ID：MH1、M10、M11、L5、L6、L7、L8、L9。
- 已讀：`report/code-review-checklist.md`、模組 README、software-fix-bugs 與 test-case-creator skills；模組內未找到額外 AGENTS.md。
- 基準：`%TEMP%/pi-better-review-baseline.json`。本輪開始時短暫存名稱、Windows rename backoff、首次 rename 前 stat 指紋、一般 payload 遮罩及設定降級均已存在，不能把它們誤稱為本輪新增修復。

## 結論

完成安全範圍內的補強及最終模組驗證。L6 已改善；L8 補齊既有遮罩的漏洞；L9 已有修復並新增明確 EACCES 回歸。M10 的短名稱與重試修補已由回歸驗證，但硬連結／ACL 限制仍存在。L5 只縮小外部寫入者的 TOCTOU，不能宣稱根治。MH1 與 M11 保持刻意政策，待使用者決策；L7 不採用會削弱完整雜湊保障的 stat-only 建議。

## 逐項狀態

### MH1 — 政策待決；文件與保護回歸完成

- 現況仍為：字面檔案已存在時使用字面路徑；否則沿用 Pi 慣例剝除開頭 `@`。即使 `@types/` 父目錄已存在，尚未存在的 `@types/other.d.ts` 仍解析到 `types/other.d.ts`。
- 未修改 `src/path-utils.ts`，也未採用父目錄存在即改變解析的新政策。
- README 明確說明風險，及以 `./@types/foo.d.ts` 或絕對路徑建立字面檔案的現有安全用法。
- 新測試實際透過 write 工具建立 `./@types/new.d.ts`、確認正確位置及已存在字面檔案優先，同時鎖定尚不存在檔案的既有慣例。
- 父代理下一步：詢問使用者是否要偏離 Pi 的開頭 `@` 慣例；不可直接把此項標為完整修復。

### M10 — 既有修補已驗證；metadata 限制保留

- 本輪開始時已使用同目錄固定短名称 `.pi-ft-<ulid>.tmp`，以及 Windows 12 次、最高 500ms、總計約 3.25 秒的 bounded backoff；涵蓋 EPERM／EBUSY／EACCES，重試前重新讀取及比對完整雜湊。
- 本輪補強：重試前的完整雜湊檢查之後亦做最後 stat 指紋檢查與取消檢查，與第一次提交對齊。
- 新增回歸：224 字元 basename 的新建與覆寫、暫存檔清理；EBUSY／EACCES 後成功；等待重試時同大小且還原 mtime 的外部改寫必須被完整雜湊拒絕，且不進行第二次 rename。
- 既有新檔 hard-link／exclusive-create 不覆蓋策略保持不變。
- README 說明：既有檔 rename 取代仍改變 inode／硬連結關係，mode 只盡力保留，不保證 Windows ACL 或其他 metadata。
- 限制未根治：Node 原子替換不能直接保證 ACL／硬連結保留；本輪沒有引入原生 Windows ReplaceFile binding，也沒有改成非原子原地写入。

### M11 — 刻意 fail-closed 政策待決；新增回歸完成

- 保持 2 秒 diff 預算包含 worker 啟動／序列化，且必須在提交前成功產生 diff。
- 未修改 `src/diff-runner.ts`，未改從 worker ready 才計時，亦未降級為缺少完整 diff 的成功提交。
- 新增確定性測試：注入 worker 的 `OPERATION_TIMEOUT` 錯誤訊息，確認 edit 回報 no edit was committed、原始內容不變、沒有暫存檔殘留。
- 此測試驗證 timeout 協定錯誤至 edit 提交邊界的 fail-closed 契約；不是靠 sleep／idle／watchdog 驗證實際 2 秒 timer。
- 父代理下一步：若使用者要改成 timeout 後仍提交，需先明確決定新成功回傳契約；本輪不能把該既定政策稱為已修 bug。

### L5 — 部分緩解，不能宣稱消除競態

- 原有第一次 rename 前 size／mtime／inode 指紋檢查已存在。
- 本輪將相同最後指紋檢查擴及每次 Windows retry，且在每次最後 stat 完成後再檢查取消，避免取消於 stat await 期間發生卻仍提交。
- 新增確定性測試：在最後 lstat 時注入外部改寫必須 STALE_FILE；於該時刻取消必須 OPERATION_ABORTED，內容與目錄均保持不變。
- rename 與最後 stat 仍是兩個系統操作；任意非 queue 外部寫入者仍可能在之間改寫。完整雜湊檢查沒有被取代或移除。

### L6 — 已改善，同一次 edit 內重用 worker

- 新增私有 `RegexSession`，lazy 建立一個 worker，僅限單次 edit 驗證生命週期。
- worker 透過 message 接收 pattern／flags，保留上次搜尋字串；連續相同字串不再次 structured-clone 全文。搜尋範圍改變時傳新獨立字串，保持 anchors／lookaround／template 前後文語意。
- 成功、驗證失敗、取消均在 finally 等待終止 worker；不跨 edit 持久保留內容，不建立常駐全域 pool。
- 保留逐 regex execution 預算、startup grace、總驗證時間、match／payload caps 與取消語意。失敗終止期間保留受 guard 的 error listener。
- 新增回歸：三次整檔 regex 共用單一 thread 且只 clone 一次；切換 lineRange／整檔 scope 的 anchors／captures 正確；範圍 miss 的 candidateRanges 正確且不提交；第二次 regex 取消時 worker 已終止、不提交第一項替換，後續另一個 edit 可正常執行。
- 剩餘成本：不同搜尋字串仍需要 clone；不同 edit 各自建 worker，此為避免跨請求保留檔案內容的安全取捨。

### L7 — 保留安全必要的完整重讀；拒絕不安全建議

- 初始 snapshot 與提交前完整內容重讀／完整 SHA-256 比對保留；64 字元 expectedHash 仍以完整 hash 比對，32 字元 token 仍依原契約使用 prefix。
- stat 指紋僅是完整 hash 後的額外檢查，不取代 hash。
- 新增回歸：錯誤 64 字元 hash 即使前 32 字元相同，write／edit 均拒絕；Windows retry 對同大小且 mtime 還原的外部改寫仍拒絕。
- 本輪沒有為效能跳過重讀或改為 stat-only。此項不應標為削弱防護式的「效能已修」。

### L8 — 既有遮罩補齊；保留期限不變

- 原有正常 request content／oldText／newText／regex hash 遮罩已存在。
- 本輪修補：字串形式 `edits` 不再把內嵌全文寫入；超深／循環無效 request 子樹遮罩，不再直接返回未檢查 object；結構化錯誤 `rangePreview` 遮罩；INVALID_REGEX 診斷可能回顯 regex，因此該診斷訊息也僅記長度／SHA-256。
- execute 與 prepare 兩條 logging 路徑皆使用相同遮罩；原本拋給模型的 FileToolError 不被修改。logging 仍 opt-in，寫 log 失敗不遮蔽原錯誤。
- 新增回歸：深層／循環輸入、字串 edits、preview、RegExp 真實 syntax diagnostic 均不把指定 secret 寫出，且仍保留 code、length 與正確 SHA-256。
- 日誌沒有新增清理／保留期限政策。路徑及其他非 payload 欄位仍保留，不將此功能宣稱為通用 secrets DLP；一般非 FileToolError 的 message／stack 仍沿用診斷行為。

### L9 — 已有修補；新增 EACCES 回歸確認

- 原有 `loadFileToolsGlobalConfig` 已對 unreadable／invalid JSON／invalid setting 值降級 `debugLog:false` 並發出 `PI_FILE_TOOLS_SETTINGS` 警告。不存在檔案仍安靜使用 false。
- 原有測試已涵蓋 invalid bool／JSON／object 及不可讀目錄。
- 本輪新增確定性 EACCES fault injection，確認 false、恰一則含設定檔路徑的警告，不影響 extension configuration 載入。
- 測試使用獨立 temporaryDirectory 與 builtin fs mock；沒有讀寫使用者真實 settings／auth。

## 本輪變更檔案

相對 `%TEMP%/pi-better-review-baseline.json`，手動修改恰為以下六個既有檔案；全部檢查為 LF、無 CR：

1. `modules/file-tools/src/file-operations.ts` — RegexSession／worker message protocol、collectRegexMatches／validateEdits lifecycle、atomicWrite retry 指紋及最後取消檢查。
2. `modules/file-tools/src/debug-logging.ts` — redactRequestForLog 深度遮罩與額外 payload keys；describeError preview／regex diagnostic 遮罩。
3. `modules/file-tools/tests/file-operations.test.ts` — M10／M11／L5／L6／L7 確定性回歸。
4. `modules/file-tools/tests/debug-logging.test.ts` — L8 深層／循環／字串 edits／preview／syntax diagnostic 與 L9 EACCES 回歸。
5. `modules/file-tools/tests/path-image-regressions.test.ts` — MH1 慣例及現有 literal-create workaround 回歸。
6. `modules/file-tools/README.md` — `@` 新檔用法、worker 重用生命週期、完整 hash 不降級、rename metadata 限制、logging 遮罩範圍。

新增驗證證據（UTF-8、LF）：

- `modules/file-tools/test-evidence/checklist-targeted.log` — 第一輪 15/15。
- `modules/file-tools/test-evidence/module.log` — 第一輪模組 4/4 stages。
- `modules/file-tools/test-evidence/checklist-targeted-final.log` — 最終目標集 21/21。
- `modules/file-tools/test-evidence/module-final.log` — 最終模組全部階段。
- `modules/file-tools/test-evidence/results.json` — 最終數量摘要與 skip 原因。

既有 module runner 自動寫出的 `plan/evidence/file-tools-*.log` 與 `plan/evidence/module-file-tools.json` 為驗證副產物；未手動更動 root scripts／tests／docs／checklist／provenance。

## 實際驗證

環境：Windows、Node v26.8.1；production host 為 Pi 1.0.0。

1. 初次目標測試：15 passed、0 failed、0 skipped。
2. 初次 standalone 模組 tsc：exit 0，無診斷。
3. 初次 `npm run test:module -- file-tools`：4/4 stages，exit 0。
4. 最終目標測試（最終修改後執行）：
   `node --import tsx --test --test-concurrency=1 --test-name-pattern='checklist|file-tools debug logging|MH1' modules/file-tools/tests/file-operations.test.ts modules/file-tools/tests/debug-logging.test.ts modules/file-tools/tests/path-image-regressions.test.ts`
   結果：21 passed、0 failed、0 skipped。
5. 最終 `npm run test:module -- file-tools`：4/4 stages，exit 0。
   - typecheck：passed。
   - module unit：245 cases，244 passed、0 failed、1 existing skip。
   - tooling：16 passed、0 failed、0 skipped。
   - packaged runtime integration／真實 Pi 1.0.0 loader：8 passed、0 failed、0 skipped。
   - 唯一 skip 是 Windows 上既有 POSIX-only `/c`／`/mnt/c` path normalization 案例；未把 skip 算成通過，POSIX 分支仍未於本輪驗證。

沒有放寬斷言、改大預算、停用測試或為 resource contention 調整測試。沒有新增以 idle／watchdog／固定 sleep 驗證 timeout 的案例。未回退整個 source baseline 跑紅測試；新增案例以可控 fs／worker fault injection 與 observable commit／thread／clone 行為驗證缺陷契約。

未執行 root `npm test`、cross、完整 integration、package 發布驗證及其他模組／browser 分組，理由為本委派只修改 file-tools；root `npm run build` no-op 未另跑。模組分組已涵蓋自身 typecheck／unit／tooling／packaged real-host integration，不能用此結果宣稱全專案通過。

## 父代理交接

- 更新根 checklist 時依上列逐項狀態，不把 MH1／M11 的刻意政策或 M10 ACL／L5 TOCTOU 限制標為完整修復。
- provenance／根 README 與 docs 同步由父代理負責；本輪未觸碰。既有 51 項 provenance mismatch 是父代理已識別的基準狀態，不能歸因為本輪造成。
- reviewer 應聚焦 `RegexSession`、`collectRegexMatches`、`validateEdits`／`validateEditsWithSession`、`atomicWrite`、`redactRequestForLog`、`describeError`，以及上列六個變更檔案。
- 真實使用者 settings／auth 未更動；tool 名稱／公開 schema／Pi trust／queue 語意及完整 hash stale 防護均保留。
