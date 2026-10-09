# Note Tools／GPT Speed 審查修補結果（M16、L20–L23）

日期：2026-10-08。範圍：只手動修改 `modules/note-tools/**` 與 `modules/gpt-speed/**`；本報告依委派要求使用 note 新增。沒有編輯 checklist、root docs／provenance／scripts／root tests，也沒有存取或修改使用者真實全域 settings／auth。測試全部使用隔離暫存 agentDir／workspace，未呼叫真實 provider 或付費模型。

## 基準與查證

已讀取 `report/code-review-checklist.md`、兩個模組 README、software-fix-bugs 與 test-case-creator skills。兩個模組沒有額外 AGENTS.md。以 `%TEMP%/pi-better-review-baseline.json` 的 path／SHA-256 清單確認此次讀到的原始檔正是委派時基準，避免把舊 checklist 當作當前程式碼。

- 原 `note.ts` hash：`5ab49a831d289907a2ff6b6c5cfe18f1…`。
- 原 `gpt-speed.ts` hash：`ee66d2d818e06441394ef787fadca73a…`。
- 基準已存在多項修補，以下明確區分既有修復與本次補強。

## 逐項結果

### M16 — 原報告問題已於委派前修復；本次補強完成

基準程式已 realpath 設定檔、沿用 mode、同步重試 ELOCKED（10 次嘗試／20ms 間隔），並保留 Windows rename 有限重試。故不能把上述既有修補計為此次新增。

剩餘可驗證問題：realpath／stat 使用 catch-all，可能把 EACCES 或 dangling symlink 當成新檔；原檔 mode 在鎖前讀取；暫存檔建立 mode 被 umask 過濾後可能比原檔更嚴格。

本次：
- realpath 只允許 ENOENT 進入新檔分支；lstat 拒絕 dangling settings symlink，其他錯誤 fail closed。
- 新檔使用實際父目錄路徑，既有 symlink 仍替換實際目標、不破壞連結。
- 在取得共用 proper-lockfile 鎖後讀取 mode，非 ENOENT 的 stat 錯誤直接失敗。
- 暫存檔建立後 chmod 恢復原 permission bits，避免 umask 改變既有權限；新檔維持 0600。
- 保留同步 read／merge／write／finally release 與現有 lock retry，不在持鎖時 await，不在 retry 耗盡後無鎖寫入。

回歸：保留既有跨行程鎖釋放測試、同程序持鎖耗盡且不刪他人鎖測試、symlink／mode 測試；新增可控 ELOCKED 重試成功與重新讀取其他 owner 更新、10 次耗盡、非 ELOCKED 不重試、realpath/stat EACCES、dangling symlink、chmod 不被 umask 過濾等測試。新增 retry 測試使用可控 fault injection／Atomics.wait 替身，不新增固定等待案例；原跨行程案例未弱化或移除。

### L20 — 原絕對路徑洩漏已於委派前修復；本次完成更嚴格輸出契約

基準 details／structuredContent 已沒有 absolute path，但仍含 `{ type, relativePath }`。本次依委派明示要求改為僅 `{ relativePath }`，同步修改 outputSchema 與 renderer，移除對回傳 type 的依賴。文字仍只有一個相對路徑，保留 read/edit 使用提示。

回歸：五種分類逐一斷言 details 精確等於單一 relativePath 欄位、structuredContent 同值、outputSchema 僅一個 property 且拒絕額外 type、JSON 結果不含 cwd 絕對路徑。這是核准的新契約，不是放寬原測試。

### L21 — eager 全行 regex 已於委派前修復；本次增加固定掃描界限

基準已使用逐行迴圈，遇到有效標題立即返回，normalize 只處理選中行的前 1024 個 code unit；不再存在原 map(...).find(...) 的 eager 行為。但無標題文件仍會掃描完整內容。

本次以 `MAX_TITLE_SCAN_CHARS = 64 * 1024` 限制標題發現範圍（UTF-16 code unit），只在此範圍內找第一個有效區塊外 ATX 標題／fallback 非空行；完整 note 內容仍原樣寫入，沒有截斷。

回歸：界限前標題採用、界限後標題忽略、無範圍內標題退回先前 fallback、巨大 fence 內內容不成為 fallback；既有巨大首行標題與 200 萬後續行測試保留。

### L22 — 已於委派前修復；保留並擴充驗證

基準已有 backtick／tilde fence 狀態、匹配符號／長度、區塊內標題排除與區塊外 fallback。此次沒有重寫該狀態機；僅讓既有掃描有固定 budget，新增 CRLF、3 空格 indentation、較短／錯誤符號／帶尾文字的非閉合 fence、未閉合 fence 等案例。模組 README 同步明示 fenced code 排除規則。

### L23 — 跳過程式變更；刻意規則已文件化

保留 `Date.now() + attempt`、最多 1000 次排他建立的碰撞策略。最大偏晚 999ms 僅發生於碰撞，屬可忽略且既有測試鎖定的有意設計。README 明示 filename timestamp 並非精確寫入時間證明。既有 rollover、collision、1000 次耗盡且不覆寫測試全部保留並通過。

## 修改／新增檔案

修改的六個既有檔案（全部驗證為 LF）：

1. `modules/note-tools/extensions/note.ts` — `MAX_TITLE_SCAN_CHARS`、`pickTitleSource`、`noteTool.outputSchema`、`renderResult`、execute 的 saved 結果。
2. `modules/note-tools/tests/note.test.ts` — 單一相對路徑輸出與 heading budget／fence 回歸。
3. `modules/note-tools/README.md` — 相對路徑欄位契約、有界 heading 掃描、fence 排除、L23 設計規則、TUI 無絕對路徑。
4. `modules/gpt-speed/extensions/gpt-speed.ts` — `persistMode` 的 canonical target／錯誤處理／鎖內 mode／chmod；`lockWithRetry` 保持基準既有邏輯。
5. `modules/gpt-speed/tests/gpt-speed.test.ts` — 鎖 retry、merge、fail-closed、symlink、umask 回歸。
6. `modules/gpt-speed/README.md` — 設定檔保護、同步有限重試與失敗行為。

新增的完整命令日誌（UTF-8、LF）：

- `modules/note-tools/test-module-review.log`
- `modules/gpt-speed/test-module-review.log`

既有 runner 執行命令時自動生成／更新 `plan/evidence/module-note-tools.json`、`plan/evidence/module-gpt-speed.json` 與對應 module stage logs；未手動編輯這些 root evidence 檔或 runner。本報告是依要求用 note 另行新增的紀錄。

## 實際驗證

環境：Node v26.8.1／win32。

- `npm run test:module -- note-tools`：2/2 stages 通過（typecheck、unit）；24 tests passed、0 failed、0 skipped。
- `npm run test:module -- gpt-speed`：2/2 stages 通過（typecheck、unit）；46 tests passed、0 failed、0 skipped。Windows 上實際 symlink 案例亦成功、沒有環境 skip。
- 六個手動修改檔與兩個新增 command logs 均為 LF。
- 初次直接 focused tests 的 powershell 呼叫使用 20 秒 idle timeout，在目前負載下啟動期間無輸出而被工具停止；不計通過。之後以上兩個正式 module 命令完整完成並保留進度與結果日誌。
- 未執行回退到原碼的 red run，未宣稱已實測原碼失敗。
- 未執行全域 npm test、test:cross、test:integration、test:package 或完整 check；委派要求使用上述兩個 module groups，root/provenance 整合由 parent 統一處理。這兩個 module groups 本身僅包含 typecheck／unit，沒有額外 real-host stage，不宣稱已做 real-host 驗證。

## 剩餘風險與交接

- Parent 已確認有 51 項委派前存在的 provenance mismatch；此 worker 未編輯 provenance。新增六檔變更仍須 parent 統一更新 native-modules／來源紀錄並跑跨模組驗證。
- 64 Ki UTF-16 掃描 budget 是明示的輸出 slug 選擇規則：極晚的標題不採用，可能改用前面的 fallback／純 timestamp。文件內容本身不受影響。
- Windows 不具 Unix 完整 permission 語意；實測驗證 chmod 呼叫與 symlink 保留，但 Unix 權限位結果只在非 win32 斷言。原子 rename 不保證沿用原檔 ACL／hard-link identity，沒有把此修補誇稱為 ACL 保留。
- 共享 proper-lockfile 的既有 stale／heartbeat 行為保持不變；同步 lock 等待上限約 180ms，Windows rename 另有最多約 180ms 等待。這不是 OS sandbox 或對任意不合作寫入者的完整防護。
- 未變更 Pi SDK 方法／hook API 或新增 API 使用；僅修改既有 note 結果資料欄位與內部檔案寫入邏輯。
