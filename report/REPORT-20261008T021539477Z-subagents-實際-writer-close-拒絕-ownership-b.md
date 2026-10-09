# Subagents 實際 writer close 拒絕：ownership barrier 修復

## 結論與交付狀態

已查證並修復獨立 reliability reviewer 所指出的實際 `FileHandle.close()` 拒絕被吞掉問題。模組驗證通過，可交由 parent 整合 provenance、cross/package 與最終 checklist；本報告不代表原始 checklist 所有其他 findings 已由本 worker 重驗。

## 查證

現行 `SubsessionWriter.closeHandle()` 原本 `.catch(error => this.fail(error))` 將 close 拒絕轉成 fulfilled Promise；`abandon(reason)` 又先設定 `writeError`，因此 `fail()` 的 `??=` 掩蓋 close 診斷。Runner 正常 finally 只檢查 IoGate 的 pending/stopped 與 child close，未確認 writer 實際 close 成功，可能 rollback、宣告 ready 與 release。既有晚到清理有 await abandon，但原本 fulfilled barrier 同樣令其 release。

## 實際修改檔案

- `modules/subagents/extensions/subagent/subsession-log.ts`：`closeHandle()` 記錄明確 `Writer close failed`，保留先前 primary error，cached close Promise 保持拒絕且不自動 retry；`abandon()` 立即附 rejection observer，但回傳原 rejecting ownership barrier；`finish()` 捕捉 close 拒絕，維持 `finalize()` 的 `{ error }` contract，不 rename。無 stagingDir 的 v2 metadata 初始化故障改走同一 close helper，避免次要 close error 隱藏 primary metadata error。
- `modules/subagents/extensions/subagent/index.ts`：runner 追蹤 `writerCloseConfirmed`；實際 writer 建立後標記未確認，僅 successful finalize 或 successful awaited abandonment 才確認。正常 block/rollback/release 分支加入此條件；晚到分支仍須 await 現在會拒絕的 abandon。一般與晚到 create 的 abandonment 都立即附 handler。
- `modules/subagents/tests/subsession-log.test.ts`：增加 finalize/abandon 兩種實際 handle.close 拒絕回歸，驗證 structured error、primary+close diagnostics、partial 檔保留、不 rename、重复 abandon 仍 reject、僅一次 close。
- `modules/subagents/tests/review-lifecycle.test.ts`：增加 normal、write-failure、late、late-create 四種 runner 回歸，驗證 actual close 拒絕時不 commit、不 block/rollback/ready、不 release，writer.lock 與 running manifest 保留，canResume=false，沒有 unhandledRejection。
- `modules/subagents/README.md`：補充實際 close 成功 barrier、失敗時保留 lock/diagnostics、無自動 retry、晚到 cleanup 與手動恢復注意事項。

`modules/subagents/tests/runner-io.test.ts` 僅閱讀／執行，未修改。未修改任何其他 code、root manifest、docs/provenance 或 checklist。

## 回歸與驗證證據

### Red-run（產品修改前）

命令：

```powershell
node --import tsx --test --test-concurrency=1 --test-name-pattern="actual handle close rejection|actual writer close rejection.*normal" modules/subagents/tests/subsession-log.test.ts modules/subagents/tests/review-lifecycle.test.ts
```

3 tests，0 pass，3 fail，0 skip，exit 1：

1. Runner normal：`canResume` 為 true，預期 false；舊程式已越過 failed-close barrier 並進入宣告可回復的分支。
2. Writer finalize：錯誤僅為 `injected actual close failure`，缺明確 close 診斷；後續 barrier assertions 尚未到達。
3. Writer abandon：`Missing expected rejection`，實際 close 失敗被轉成 success。

late regression 未先 red-run，避免舊程式缺乏 late rejection diagnostic 時只得到等待取消／測試 timeout，而非有意義 assertion。

### Green targeted serial

```powershell
node --import tsx --test --test-concurrency=1 modules/subagents/tests/subsession-log.test.ts modules/subagents/tests/runner-io.test.ts modules/subagents/tests/review-lifecycle.test.ts
```

最終 38/38 pass，0 fail／cancelled／skip。既有 successful normal close、pending abandoned close 後晚到 release、writer creation failure 無 handle 的 release，以及所有八個 child permits/locks 的 actual child close 後 release 都仍通過。新增協調使用 deferred barriers／AbortController；唯一 event-loop drain 為 setImmediate，沒有新增 fixed sleep 或 timeout 行為測試。

### 完整 subagents 模組分組

```powershell
npm run test:module -- subagents
```

3/3 stages pass：

- `subagents:typecheck` 通過。
- `subagents:test`：269/269 pass，0 skip。
- `subagents:test:integration`：36/36 pass，0 skip；包含實際 Pi 1.0.0 CLI／RPC 與隔離 mock provider probes。

本次環境：Windows、Node v26.8.1。證據：

- `plan/evidence/module-subagents.json`
- `plan/evidence/subagents-typecheck.log`
- `plan/evidence/subagents-test.log`
- `plan/evidence/subagents-test-integration.log`
- targeted 與 module 合併 shell log：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-ZQSkP8\output.log`（temp，非永久證據）。

額外嘗試 `git diff --check`／`git diff --stat` 未能執行：此 workspace 無 Git repository metadata，`git rev-parse --show-toplevel` 明確回報 `not a git repository`。此為工具環境阻礙，不列通過。

未執行根層 whole groups：npm test、完整 typecheck/build、test:cross、test:integration、test:package/check，遵照本次模組專責分工；parent 負責必要根層重新驗證。

## Startup／partial creation 與剩餘風險

- Production runner 一律使用 v2 + managed stagingDir；open 後沒有 legacy header 或獨立 run.json 初始化寫入，再由 runner 立即保留 actual writer。既有開檔前 create failure 回歸與新增晚到 create + close reject 回歸均通過。
- Legacy v1 fixture 與非 managed staging 的 v2 工廠初始化若 primary I/O 與 close 同時失敗，現在保留 primary+close diagnostics；但 factory 仍以 reject 結束，沒有新公開 API 交出 partial writer owner，也沒有新增這兩個非 production 路徑的雙故障 fault-injection 測試。本次不改 factory ownership 公開介面或另行設計恢復／retry。
- Close 拒絕代表尚未確認資源關閉，並不證明 OS handle 一定仍開啟；因此保守保留 live lock nonce 和磁碟 lock，manifest 可能仍 running/committing。沒有自動重試或自動清锁，故障處置仍須人工確認實際 owner／process／I/O 已終止；receipt 完成不是安全删除鎖的依據。
- 本修復不改 child permits、取消／timeout、schema、儲存路徑、trust 或 global settings/auth。沒有呼叫付費模型。

## Parent 精確下一步

1. Reconcile 上述 5 個修改檔案的 provenance（特別 `SubsessionWriter.closeHandle/abandon/finish/create` 與 runner `writerCloseConfirmed`／finally lifecycle）。
2. 對最終整合 snapshot 執行所需 cross/package 與其他根層驗證；不要把未執行組別算通過。
3. 更新最終 code-review report/checklist，納入這個追加 reliability finding 的 red/green 與 conservative retained-lock residual。
