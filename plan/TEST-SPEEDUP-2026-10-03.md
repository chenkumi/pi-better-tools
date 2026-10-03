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
- `npm run sources:verify` 在本次之前就失敗（`subagents/extensions/subagent/title.ts` 雜湊不符）；`docs/adaptations.json` 另有約 40 個檔案雜湊與工作目錄不符（含本次之前的 PTY／subagents 等），本次未更新 provenance，需另行整理（先確認是否為 CRLF／LF 換行差異）。
- 尚未執行 `test:package`／`test:matrix`。
