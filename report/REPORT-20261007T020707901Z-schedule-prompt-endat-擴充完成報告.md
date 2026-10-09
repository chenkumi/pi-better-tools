# Schedule Prompt endAt 擴充完成報告

## 交付

依 `plan/PLAN-20261007T014010046Z-schedule-prompt-原生截止欄位-endat-擴充計畫.md` 完成原生 `endAt`。工具 add/update 接受含時區、严格有效日期的 ISO 時間並存 UTC；update 省略保留、null 清除。到期阻擋新觸發並停用／清除 nextRun，既有 prompt 可完成而不強停。截止 timer、重啟、fresh dispatch 與非同步初始化後 prompt admission 都有防線；已停用 recurring 工作僅延長／清除期限不會啟動。UI、文件與 `docs/adaptations.json` 已更新。

現有 Pi session 仍需 `/reload` 或重啟才載入新 schema/實作。維持 store v1、Pi 1.0.0 支援基準與第三方 MIT 身份；不更動真實 settings/auth/排程，不呼叫付費模型。

## 實際驗證

- `npm run test:module -- schedule-prompt`：206 tests／13 files、TS 與離線真實 Pi 1.0.0 host probe 通過，零 skip。單一模組範圍。
- `npm run test:cross`：SDK hooks、provenance 與九入口載入整合 3/3 階段通過；新增 runner/fixture/provenance 必須驗證此組。
- `npm test`：首次 Subagents 有 8 個 setup I/O timeout 失敗，原始 JSON/log 已保留；不改期限或斷言。隔離 runner-io 重跑 17/17 通過，第二次根單元 10/10 階段完成、零失敗（Subagents 223/223）。File Tools 有 1 個 Windows 平台既有 skip，該案例不算通過。
- 最終 `npm run typecheck`：9/9 通過；`npm run build` 通過（manifest 的 no-op）。
- `npm run sources:verify`：195 snapshot hashes、93 adaptations、64 added integration files 與21 native files 驗證；5 筆既有 historical-delta warnings 保留，不能據此宣稱歷史 diff 等價。
- 獨立 reviewer 三輪唯讀審查的兩項有效發現已修正並加入回歸測試；最後未發現新的重要問題。Reviewer 未執行動態測試。

## 未執行／限制

全量 `test:integration`、`test:package`、`check`、`test:browser` 未執行（本次未發布、改 package files 或 Web）；不得視為通過。工作目錄無 `.git`，無法執行 Git diff/status，也未 commit／發布。根 I/O 初次失敗可能受重度驗證競爭影響，但此原因僅為推論，不抹除失敗紀錄。截止是 dispatch admission，不是實時完成期限或 OS sandbox；舊／混合 extension 版本不能保證截止。

## 證據

`plan/evidence/module-schedule-prompt.json`、`unit.json`、`typecheck.json`、`cross.json`；首次失敗 `schedule-deadline-unit-initial.json`／`schedule-deadline-subagents-initial.log`；隔離重跑 `schedule-deadline-runner-io-recheck.log`。完整進度與歷史保留於原計畫。