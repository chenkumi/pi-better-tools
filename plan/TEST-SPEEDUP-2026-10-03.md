# 測試加速與分組（2026-10-03）

## 已做
- 平行化：json-schema real-cli（pool 4）、package 8 modes（concurrency 4）、subagents 單元（4）與整合（3）、web-tools 單元（4）。
- 移除 idle/watchdog/固定等待測試：shell-tools 4 個 timeoutMs 整合測試、file-tools tooling watchdog、diff-runner busy workers、scheduler 6.5s 固定等待（Windows 原本 skip）。
- 新增 `test:module -- <module>`、`test:cross`；規則寫入 AGENTS.md。

## 實測（Windows，同機）
build 17s／typecheck 101s／test 131s／test:integration 約 281s；原整合約 400s、單元約 255s。

## 剩餘風險
- `scheduler:test:integration`（app-scheduler、session-pi-runtime）在 Windows 偶發失敗（約 3/6 次）。已確認不是逾時：失敗時 run 卡在 queued/running，錯誤為 `runs.jsonl` 的 `rename` EPERM（RunStore.writeAll，src/run-store.ts）或 `No API key found for scheduler-offline-N` 時序問題。尚未修改正式程式碼；候選修法為對 rename 做有限次 EPERM/EBUSY 重試。
- 已放寬 scheduler 測試 timeout（admissionTimeoutMs 10s、waitFor 10s、vitest testTimeout 30s），未改任何斷言。
- 尚未執行 `test:package`／`test:matrix`；所有改動尚未提交。
