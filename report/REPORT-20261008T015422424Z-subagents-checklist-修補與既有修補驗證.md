# Subagents checklist 修補與既有修補驗證

- 日期：2026-10-08。
- 授權程式範圍：僅 `modules/subagents/**`。本文件依使用者要求由原生 `note` 建立。
- 已讀：`report/code-review-checklist.md`、完整模組 README、software-fix-bugs / test-case-creator skills；模組內未找到 AGENTS.md。沒有變更 Pi SDK API，因此未進行不必要的 SDK 文件／API 遷移。
- 基準：對照 parent 的 `%TEMP%/pi-better-review-baseline.json` 與首次 read。Checklist 描述並非全部仍存在：H1、M1、M2、M3、L3、L4 的主要程式修補在本次開始前已存在，不列成本次新修。
- 最終結論：M4 晚到 I/O 收尾與跨 loader 的 live-owner 防護已補上；既有六項修補通過回歸；L1、L2 基於已明示的背壓／完整性策略保留。最終 targeted 72/72、模組 typecheck + unit 263/263 + real-host integration 36/36 全通過，無 skip。

## 逐項狀態

| ID | 狀態 | 說明與證據 |
| --- | --- | --- |
| H1 | 已存在修補，本次驗證 | `confirmProjectAgents` 仍保留公開 schema，但程式忽略其值。未信任 project 來源：有 UI 一律確認，無 UI 拒絕。既有 runner tests 的 `confirmProjectAgents=false` UI/no-UI 案例、title 的拒絕案例與完整模組 tests 通過。未調整 trust 或 resume 的嚴格驗證。 |
| M1 | 已存在修補，本次新增回歸並保留保障 | Runner 已有 childExited 驅動的 permit retention、`!childGone` lock 防護與 abandon 管道 destroy。本次 late-cleanup 統一接管 lock 收尾，但仍須實際 child close；新增八個 kill-failed children 同時 abandon 測試：八個 writer.lock 仍存在、stdout/stderr destroyed、第九個被取消的排隊請求不 spawn，實際 close 後八個鎖才釋放。既有 process-wide limit / semaphore tests 也通過。 |
| M2 | 已存在修補，本次新增端到端 writer 回歸 | `SubsessionWriter.finish()` 已使用 `renameWithRetry`。新增真實 transcript writer 測試，在 Windows 注入兩次 EBUSY，第三次 rename 成功；確認最終路徑、完整 done record、無 error。既有 retry helper 對 transient / persistent / non-Windows 的案例通過。 |
| M3 | 已存在修補，本次驗證並補文件 | Spawn 已為 POSIX 設 `detached:true`；kill helper 預設 `process.kill(-pid, signal)`，失敗才 fallback direct child；Windows 保留 taskkill /T /F 與 direct kill。既有 POSIX group/fallback、Windows taskkill tests 通過。README 原先只寫 direct child，已改為正確說明 process group。沒有宣稱 process tree 已被證實全部停止。 |
| M4 | 本次完成補強 | 已有 nonce registry，但 timeout/abort 後 pending native/transcript I/O 的 owner 仍可能永遠保留鎖。本次加入 IoGate actual-idle barrier，保留 late allocate/acquire/begin/writer ownership，等 child close、所有實際 gated I/O、spool iterator return、writer abandon/close 都完成後，才 block/release。Late cleanup 不 rollback、不發布 ready、不把失敗 receipt 改為 canResume。Nonce registry 改為 Symbol.for process-wide Set，reload/不同 loader instance 不會把另一 instance 的 live nonce 誤當 orphan。新增 canceled late-acquire、distinct loader ownership 回歸；既有 abandoned-close 測試改為同時驗證 pending 時仍鎖住及實際 close 後釋放為 blocked，非減少原保障。 |
| L1 | 跳過，保留已明示策略 | ToolResultSpool 明示 caller owns serialization/backpressure、沒有 pending promise queue、payload cache 或 in-memory index；fallback 需先有 acknowledged disk evidence，canonical logging 後才移除。延遲 put 需要新的 bounded cache、spill、ack/remove 與 cancellation/cleanup 排序，非安全的小改；取消目前的 await 會破壞現有背壓及實際 I/O lifecycle。既有 spool failure/artifact/order/backpressure tests 全通過；沒有宣稱已優化。 |
| L2 | 跳過，完整性／容量策略優先 | validateCheckpoint、commit 與 rollback 的 hash 是不同交易時間點的檢查，不能直接共用之前的結果；diskUsage 在持久化目錄改變前後重檢 soft-policy 與 symlink。mtime/size cache 或把 scan 結果跨階段重用會弱化對相同大小改寫、外部新增檔案或 symlink 的防護。沒有完成可保持相同安全性的效能量測／替代設計，因此不以 optimization 為由刪除 barrier。STORE native-edit/prefix-edit/symlink/checkpoint 與 commit 故障案例通過。 |
| L3 | 已存在修補，本次驗證 | Async stdout parser 已維護 bufferBytes，按新 fragment 累計 UTF-8 bytes，換行重設，不反覆對整個 partial record 掃描。既有多 chunk counter、UTF-8、8 MiB ±1 邊界與 terminal discard tests 通過；保留 8 MiB 上限。 |
| L4 | 已存在修補，本次新增回歸並補文件 | Assistant output 2 MiB 與 alias/key bookkeeping 8 MiB 已分開。新增 75 個 assistant tool-call batches、7,500 個 canonical tool results 的 runner accounting 回歸；identity retained bytes 超過舊 2 MiB cap 仍完成且完整保留 final answer。此測試只替身 writer/commit，定位 runner accounting；真實 storage/commit 安全性另由既有 unit 與 CLI integration 覆蓋。README 補正兩種獨立 budget。 |

## 本次精確異動

對照 parent 基準，模組內只有下列五個既有檔改變，另新增一個測試檔；未修改其他模組、根 scripts/tests/docs/provenance/checklist。所有六個檔已檢查 CR count=0，維持 LF。

1. `modules/subagents/extensions/subagent/index.ts`
   - `runSingleAgentUnlimited`：記錄晚到 allocate/acquire/begin/writer owner；追蹤 spool iterator return；統一在實際 child / I/O / iterator / writer barriers 後 block/release late lock。
   - 保留 child argument builder、exclude-tools、8 active permits、native digest/checkpoint、resume trust 及 public schema。
2. `modules/subagents/extensions/subagent/io-gate.ts`
   - `IoGate.whenIdle()`、`completed()` 與實際 completion waiter Set。stop 只中止等待；idle 不因 stop 而假裝完成。
3. `modules/subagents/extensions/subagent/session-store.ts`
   - `liveLockNonces` 改用 process-wide Symbol.for registry，跨 reload/duplicate loader 共享；無持久化格式變更。
4. `modules/subagents/tests/runner-io.test.ts`
   - fixture 以真實 writer release barrier 等待 cleanup；僅已實際 acquire 才等待 release。
   - abandoned close：仍驗證 pending lock/state，實際完成後驗證 lock 消失、manifest blocked、receipt 不被 promote。
   - IoGate 測試確認 stopped wait 與 actual-idle 分離。
5. `modules/subagents/README.md`
   - 對齊既有 POSIX group termination、output/identity budgets、checkpoint-based stale-lock recovery；說明本次 late cleanup barriers 與 residual lock retention。
6. **新增** `modules/subagents/tests/review-lifecycle.test.ts`
   - distinct loader live nonce ownership、Windows readable rename retry、7,500 tool identity accounting、八個 abandoned children 的 permits/locks、cancelled late acquire 五個案例。

### 最終 SHA-256（供 parent 精確更新 provenance，不是盲目 re-sign）

```text
modules/subagents/extensions/subagent/index.ts
  e2e353db84c6dec244a7b0dbbd3686338cc6ffa3c81547288ef42558042f1a18
modules/subagents/extensions/subagent/io-gate.ts
  8fd63f4bd65774c8631a1bccf7d26b6555897b0ec6c8c0d423d9635b7c0368bc
modules/subagents/extensions/subagent/session-store.ts
  d71bf18a4ea9f8905a8dbad031b97986d2df83b763c0886e0f8bfbfbaf19998b
modules/subagents/README.md
  4ae49dd7a95cbe4dfd49805ad561f9883a3e606ea9bb5fa0da6975764367f080
modules/subagents/tests/runner-io.test.ts
  83b8828a989c0c5621c4c918dd71e17a18f536b5feb87705b1b45f6df5082580
modules/subagents/tests/review-lifecycle.test.ts
  12da518fff985e73084789c8ad21b53d9c8ed44b87b5b7c06115b075c8ccf0fd
```

## 驗證與失敗歷程

環境：Windows，Node v26.8.1；module runner 指向已安裝的 Pi 1.0.0 CLI。實際 host tests 使用隔離 workspace/home/agentDir 與 fake providers，沒有呼叫付費模型、沒有改真實 settings/auth/provider credentials。

### 最終通過

- Targeted：`node --import tsx --test --test-concurrency=1`，檔案為 `protocol.test.ts`、`review-fixes.test.ts`、`review-lifecycle.test.ts`、`runner-io.test.ts`、`session-store.test.ts`。
  - **72/72 passed，0 failed/cancelled/skipped**，exit 0。
  - 使用 `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`。
  - 日誌：`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-targeted-final.log`。
- `npm run test:module -- subagents`，在最終 targeted 後執行。
  - **3/3 stages passed**：typecheck、unit **263/263**、real-host integration **36/36**；0 failed/cancelled/skipped，exit 0。
  - UTC：2026-10-08T01:48:07.754Z 至 2026-10-08T01:51:56.226Z。
  - 獨立 captured 日誌：`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-module-final.log`。
  - 完整 shell log：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-TSlck4/output.log`（含 final exit codes）。
  - 標準 runner 自動輸出的 evidence：`plan/evidence/module-subagents.json`、`plan/evidence/subagents-typecheck.log`、`plan/evidence/subagents-test.log`、`plan/evidence/subagents-test-integration.log`、`plan/evidence/subagents/`。這些是執行要求的既有 runner 產物，不是手動編輯根測試／文件。
- 額外 standalone `tsc -p modules/subagents/tsconfig.json` 曾 exit 0；最終 module typecheck 已再次驗證最終程式。

### 未隱藏的早期失敗

1. 第一個多檔 targeted 沒指定 serial，PowerShell tool 的 20 秒 idle timeout 在只有 protocol output 後中止；**不算通過**。該工具 idle timeout 是本次命令設定失誤，非產品 timeout 測試結論。
   - Partial log：`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-targeted.log`。
2. 初次 runner-io 單檔在並行 worker 負載下 **11 passed / 6 failed**；失敗多數在注入點之前的 300ms allocate/begin setup 期限，另有 fixture 不應等待不存在的 acquired lock。未提高 deadline 或放寬斷言；fixture 改為只在 actual acquire 完成後等待真實 release，最終 17 個 I/O tests 全通過。
   - 日誌：`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-io.log`。
3. 首版新 M1 測試把 spawn 順序當作 controller identity，8 個並行 startup 的順序不固定，造成取消到其他 invocation、30 秒 test cancellation。修正為 runtime mock command 攜帶 invocation index，不改產品 timeout 或測試斷言。
   - 初次 lifecycle：3 passed / 1 cancelled，`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-lifecycle.log`。
   - 修正後四案例 rerun：4/4，`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-lifecycle-rerun.log`。
4. 第一輪 module 在上述測試修正前已讀入舊測試：typecheck 與 integration 通過，unit 261 passed / 1 cancelled，**2/3 stages，exit 1**，不算整組通過。
   - 日誌：`C:/Users/KY6584/AppData/Local/Temp/pi-subagents-review-module.log`。
   - 最終完整重跑已包含修正後五個新案例與所有既有 unit/integration，結果如上。

未將程式切回舊版做 red-run；沒有宣稱已執行原始缺陷版本。回歸依可觀察 ownership、實際完成事件、record 完整性及獨立 byte budgets 判定，不靠固定 sleep 判定新增案例的 timeout 語意。

## 未執行分組與剩餘風險

- 未跑全專案 `npm test`、根全部 typecheck、`test:cross`、全模組 `test:integration`、`test:package` 或 `check`；本次只有一個模組，依指定 module 分組驗證。根 cross/provenance 與 parent 的多模組整合、完整發布驗證由 parent 決定；未跑不算通過。Build 為根 no-op，未單獨跑。
- 未在真正 POSIX OS 上測試整棵孫行程終止；Windows 上的 helper tests 模擬 POSIX 分支，code inspection 確認 detached/group signal。逃離 process group、遠端 provider 與失敗的 taskkill 仍是 best-effort；actual direct child close 也不是整棵樹或 API 都停止的證明。
- 永遠不 settle 的實際 I/O／child、ownership metadata 發布失敗、或 late block/release 故障，仍會保留 writer lock/diagnostics，必要時人工檢查；這是保護 writer 的必要 residual，不自動接管 live owner。Late cleanup 失敗有 bounded internal diagnostic 與 stderr 訊息，不 promote ready。
- Finite Windows rename retry 不能保證任意長的讀取鎖都會恢復；persistent denial 仍失敗並保留 partial evidence。
- L1/L2 沒有變成 async spool 或弱化 hash/scan；若日後要效能重設計，需另設 bounded cache／spool drain 與相同完整性策略並量測。
- Parent 提到的 51 個既存 provenance mismatches 未在本次 re-sign；請只依 baseline、實際 changed/new files 與已確認 adaptations 更新，避免把其他既存變更混稱本次修復。

## Parent 下一步

- 在根 checklist 把 H1/M1/M2/M3/L3/L4 標為「先前已修，本次驗證」，M4 標為「本次完成補強」，L1/L2 標示有理由的保留／跳過；不要把九項全宣稱為本次程式修復。
- 更新上述實際修改檔與新增測試的 provenance / adaptations，必要時同步根 docs 描述；本 agent 沒有越權編輯這些檔。
- Key functions/types：`runSingleAgentUnlimited` late lifecycle cleanup、`IoGate.whenIdle/completed/run`、`ManagedSession` 的 process-wide `liveLockNonces`；公開 schemas、manifest/storage 格式與 child argument builder 均未變。
