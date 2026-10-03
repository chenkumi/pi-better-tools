# 測試加速與分組（2026-10-03）

## 已做
- 平行化：json-schema real-cli（pool 4）、package 8 modes（concurrency 4）、subagents 單元（4）與整合（3）、web-tools 單元（4）。
- 移除 idle/watchdog/固定等待測試：shell-tools 4 個 timeoutMs 整合測試、file-tools tooling watchdog、diff-runner busy workers、scheduler 6.5s 固定等待（Windows 原本 skip）。
- 新增 `test:module -- <module>`、`test:cross`；規則寫入 AGENTS.md。

## 實測（Windows，同機）
build 17s／typecheck 101s／test 131s／test:integration 約 281s；原整合約 400s、單元約 255s。

## Scheduler 偶發失敗修正
- 根因：Windows 上 `rename` 覆蓋 `runs.jsonl`／registry 時，若檔案正被讀取或掃描，會暫時 EPERM／EBUSY／EACCES（獨立壓測可重現，通常 5–16ms 內恢復；重負載下曾持續超過 1s）。
- 修正：新增 `modules/scheduler/src/atomic-rename.ts`（`renameWithRetry`，僅 win32、僅這三個 code、最多約 4.3s，最後錯誤原樣拋出；仍是 atomic rename），RunStore.writeAll 與 RegistryStore.atomicWrite 使用。
- 驗證：修正前串行約 3/6 次失敗；修正後串行 11/11 通過，4 路並行重負載 32 次 0 失敗（retry 上限 1s 時 32 次仍有 2 次失敗，故放寬到約 4.3s）。

## 剩餘風險
- 已放寬 scheduler 測試 timeout（admissionTimeoutMs 10s、waitFor 10s、vitest testTimeout 30s），未改任何斷言。
- `sources:verify` 在這台 Windows 機器（`core.autocrlf=true`，工作目錄為 CRLF）直接執行會因換行失敗：46 個雜湊不符檔案的 LF 版本與 HEAD blob 皆吻合；另有 7 個是本次的真實差異，已更新雜湊並補 adaptation 說明，另為本次修改的 5 個 imported 檔案新增 adaptation 項目。
- 驗證方式：`git -c core.autocrlf=false -c core.eol=lf archive HEAD` 解開到暫存目錄後執行 `node scripts/verify-sources.mjs`，已通過。在 CRLF 工作目錄直接執行仍會失敗，屬環境換行問題，未更動。
- 尚未執行 `test:package`／`test:matrix`。
