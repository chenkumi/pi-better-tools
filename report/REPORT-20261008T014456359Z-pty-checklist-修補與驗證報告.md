# PTY checklist 修補與驗證報告

- 日期：2026-10-08。
- 授權範圍：僅 `modules/pty-terminal/**`；依委派要求另外以原生 note 保存本報告。未修改 root docs、provenance、checklist、scripts、root tests，未使用或修改真實使用者 settings/auth。
- 基準：以目前工作樹逐項讀碼，並與 `%TEMP%/pi-better-review-baseline.json` 的檔案雜湊比較。該工作樹在本次委派前已包含多項修補，以下明確區分「基準已修」與「本次補齊」。模組無 AGENTS.md，已完整閱讀模組 README、checklist、software-fix-bugs 與 test-case-creator skills。

## 各 ID 狀態

| ID | 基準查證 | 本次完成內容 | 回歸證據／限制 |
| --- | --- | --- | --- |
| MH2 | 部分已修：已有 50ms debounce，但只涵蓋輸出在失敗 worker 尚執行期間到達的情況。失敗完成後才到達的 chunk 仍可立刻重啟 worker。 | 每次失敗後建立 retryAt，無論新輸出於執行中或失敗後到達，重試均合併 50ms；deadline 耗盡不再啟動新 worker；exit 可提前喚醒檢查最後輸出，abort 不 drain。 | 可控時鐘驗證 49 個連續 chunk 不新增 worker，第 50ms 一次重試涵蓋所有輸出；驗證 deadline、abort、exit、cursor 與 unread 保留。原同步 matcher 替身測試改成明確推進 debounce 時鐘，未放寬正確性斷言。 |
| M14 | 部分已修：已有 5 秒 startup allowance，但 compute 預算從 Worker online 起算，ESM 模組載入仍被算入。 | worker 在模組載入／workerData 準備後先送 ready receipt，再執行 RegExp；host 從 ready 開始 compute budget，保留 5 秒 startup 上限、最多 16 個 worker、最高 1000ms compute budget。 | 新單元測試在 online 後推進 4999ms，1ms compute 預算仍可成功；另驗證 startup 與 compute 個別上限。真實 worker 災難性 alternation／abort／shutdown 測試通過。 |
| M15 | 基準已修：escape.ts 已單趟支援字面雙反斜線與 x5c，tool description 與 README 已說明。 | 不重寫既有 decoder；補 data parameter description 的字面反斜線說明，新增 shield r/n/f/t/v/x/u、連續反斜線、尾端反斜線與 x5c 不二次解碼案例。 | escape.test.ts 通過。Windows 路徑需使用文件化跳脫方式，裸反斜線控制序列仍按既有語意解碼。 |
| L24 | 尚未完整修復：基準只優先回收已讀 exited session，仍會回收未讀 exited session。 | 滿載 admission 只回收輸出與 drop 通知都已讀完的 exited session；其餘拒絕 spawn 並提示先 pty_read drain 或明確 pty_kill release，不建立新的 transport。 | 驗證 unread 保留、since 重讀不 drain、drop notice 保留、drain 後 admission、explicit release；真實 PTY 容量案例改為先保護 KEEP 輸出再 drain 回收。10 分鐘 retention 期限自動回收仍為既有明示政策，未改變。 |
| L25 | 基準已修：已有 buffer slack，滿載 overflow 一次修剪至 15/16，不是每 chunk 都複製約 2Mi。 | 保留實作，新增小 chunk 回歸測試：一次 overflow 後，64 個小 chunk 不再推進 retained start；最大容量、cursor、readPos、新 unread 與 drop 仍正確。 | session-lifecycle.test.ts 通過；未宣稱所有 read／snapshot 操作都免複製。 |
| L26 | 基準已修：write 已拒絕 exited session 並提示 drain／release／spawn。 | 保留實作，強化 fake backend writes 記錄，確認拒絕輸入完全沒有送至 backend，最終 unread output 保留可讀。 | write exited regression 通過。 |
| L27 | 基準已修：pause 已訂閱 exit，底層 waitFor 亦檢查已有 exitInfo。 | 將 already-exited 短路移到配置 timer/listener 前，避免不必要資源配置；修正 README readAfterMs 不再聲稱 exit 後仍固定等待。 | 驗證等待中 exit 提早返回，以及已退出 pause 不留 timer；與 debounce exit 最後輸出測試併用。 |

## 安全與介面不變量

- 未更動工具名、參數 shape、targets/env trust resolution、named target fail-closed、SSH host-key 檢查或 credentials。
- 任意使用者 RegExp 仍只在可終止 worker 內執行；單元 matcher seam 只用已知測試 pattern。沒有以主事件迴圈 regex 執行取代隔離。
- worker receipt 後仍等待 terminate 完成才釋放 active permit；新增 16-worker 容量測試分別驗證 result、abort、budget timeout 後，termination 未完成仍拒絕第 17 個 worker，確認退出後才允許新比對。
- 保留 Windows backend 不支援 POSIX signal 的 caveat、local transport exit 不代表遠端 process tree 停止，以及 kill/shutdown 未確認退出時保留 ownership。
- 保留未讀輸出、since 非消耗重讀、ring buffer 最大值、cursor/drop 語意；所有本次修改的原始碼、測試、README 與保存的 log 已確認為 LF。

## 變更與新增檔案

### 修改

- `modules/pty-terminal/README.md`：ready budget、全面 retry debounce、deadline、exit-aware pause、滿載保護未讀輸出。
- `modules/pty-terminal/src/pty-manager.ts`：reclaim/spawn、waitMatch retry/deadline、waitFor already-exited short circuit。
- `modules/pty-terminal/src/matcher.ts`：MatcherOptions deterministic seams、ready receipt 啟動計算預算，保留 worker termination permit 路徑。
- `modules/pty-terminal/src/match-worker.mjs`：先送 `{ ready: true }`，再送 match/error receipt。
- `modules/pty-terminal/src/index.ts`：pty_write data 參數跳脫說明，無 shape 變更。
- `modules/pty-terminal/tests/escape.test.ts`：單趟解碼與字面跳脫邊界。
- `modules/pty-terminal/tests/pty-manager.test.ts`：真實 PTY exited 未讀資料保護與 drain 後回收。
- `modules/pty-terminal/tests/pty-read.test.ts`：明確驗證 bounded retry debounce，保留 ANSI/cursor/unread/deadline 斷言。
- `modules/pty-terminal/tests/session-lifecycle.test.ts`：MH2/L24/L25/L26/L27 回歸與 backend writes 記錄。

### 新增

- `modules/pty-terminal/tests/matcher.test.ts`：M14 啟動／計算分離，以及 held-until-termination worker permit 測試。
- `modules/pty-terminal/targeted-checklist.log`：首次定向驗證失敗紀錄。
- `modules/pty-terminal/targeted-checklist-rerun.log`：定向重跑通過紀錄。
- `modules/pty-terminal/module-checklist.log`：首次完整 PTY 分組驗證，保留 L24 舊契約測試失敗。
- `modules/pty-terminal/module-checklist-rerun.log`：完整 PTY 分組最終通過紀錄。

## 實際驗證與失敗處理

環境：Windows／Node v26.8.1／專案 Pi 1.0.0 基準。

1. 定向命令：`node --import tsx --test --test-concurrency=1 modules/pty-terminal/tests/matcher.test.ts modules/pty-terminal/tests/session-lifecycle.test.ts modules/pty-terminal/tests/escape.test.ts modules/pty-terminal/tests/pty-read.test.ts`。
   - 首次 23/24：既有總期限測試抓出重試迴圈到 deadline 後配置 0ms timer 的錯誤；修正產品碼為 deadline 到期直接返回，未弱化斷言。
   - 重跑 24/24 通過，0 skip／0 fail。
2. `npm run test:module -- pty-terminal`。
   - 首次 typecheck 通過，unit 62/63：既有容量測試假設含 native setup 未讀輸出的 exited session 仍可回收，與 L24 新契約衝突。改用明確 KEEP 輸出驗證 admission 拒絕、drain 與再回收，而非縮小輸出／放寬 timeout。
   - 最終重跑：typecheck 通過；unit 63/63 通過；integration 2 通過、1 個 POSIX-only 真實 SIGHUP/SIGKILL 測試在 Windows skip。runner 3/3 stages 成功，skip 不算已驗證。
   - 根 runner 自動產生 `plan/evidence/module-pty-terminal.json` 與 `plan/evidence/pty-terminal-*.log`；未手動修改 scripts 或 root tests。
3. 使用 baseline 雜湊比對列出本模組所有修改／新增，並檢查 LF；未修改未授權模組或使用者資料。

## 未執行與風險／交接

- 未跑全域 npm test、test:cross、全部 test:integration、test:package、完整 check 或其他模組：此委派限定單一模組，由 parent 處理跨模組／發布驗證。module 分組已包含 PTY typecheck、全部 unit 與 PTY integration；build 為 no-op，未另呼叫 build。
- 未驗證真實 WSL／SSH；原有 argv/settings 單元測試通過不等同遠端連線驗證。POSIX 真實 signal escalation 本環境 skipped。
- 5 秒 startup 與 compute budget 都仍是有界 wall-clock allowance；極端排程壅塞仍可能 timeout，沒有放寬既有測試或無界等待。
- 滿載不再犧牲未讀 exited output，可能需要操作者明確 drain/release 才能 admission；10 分鐘 exited retention 與 ring overflow loss notices 是既有明示限制。
- Worker protocol 現為 ready + result 兩則訊息。Parent 已通知其自行更新 `scripts/package-smoke.mjs` 的精確 ready/matched/natural-exit probe；该 root 檔案不屬本 agent 修改範圍。
- Parent 確認 baseline 有 51 個既存 provenance mismatches，並自行負責整合更新；本 agent 未改 provenance，也未宣稱來源 hash 已驗證通過。
- 關鍵 functions/types：PtySessionManager.reclaim／spawn／waitMatch／waitFor、matchPattern／MatcherOptions、match-worker ready receipt。
