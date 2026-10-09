# Shell 與 Schedule Prompt 完成訊息 TUI 改善

## 契約與範圍

使用者授權一起改善 shell-job-completed 與 scheduled_prompt。只改 TUI presentation，不更動 model-facing content、followUp/triggerTurn、工作 lifecycle 或排程統計；Schedule skipped 通知僅新增 details.skipped 用於明確呈現。兩個 renderer 各歸屬原模組，不增加跨模組 runtime 依賴／入口。

收合顯示狀態、命令／工作名稱、exit code／耗時（Shell）、三行結果預覽與截斷／log 提示；展開顯示 job ID、命令／prompt 及通知內保留的結果。Shell 優先顯示 outputTail，不憑 Error 字詞推斷失敗。Schedule 區分 starting、finished、failed、skipped、inline delivered（不是完成）。以 Pi 原生 expanded 選項，ANSI／OSC／控制碼與 bidi 清理、terminal column 寬度工具處理 Unicode。每欄位／整體 layout 都設上限，不讀 log、不執行工具。

## 已完成與實際驗證

新增兩個 local renderer 與 shell 8／schedule 6 項 focused 測試，首次新測試把 Pi truncateToWidth 的 SGR reset 誤判不安全，已改成只允許 SGR、仍禁止 cursor/OSC/C1/bidi；14 項 focused 全通過。兩模組 TS 初查無診斷。Shell integration fake host 已加入 registerMessageRenderer 介面，未弱化 lifecycle 斷言。

獨立唯讀 reviewer 指出 Shell 多行 error 的 render row 契約與 Schedule 缺 details 的 legacy content 遺失；均已修正、加入每行不含換行、legacy string/text-block／malformed blocks、空結果、有限 exit code 等回歸。最新 focused 為 Shell 10 + Schedule 8 全通過；複查未發現新的重要問題（僅靜態，未冒称動態證據）。

最終 sequential pipeline 已完成（截至 2026-10-07 02:34 UTC）：
- 根 `npm test` 10/10 階段完成、零失敗；File Tools 在 Windows 有 1 個既有平台 skip（229 pass／230 cases），該案例不算通過。初次根單元亦零失敗，但 final pipeline 另含後續 review 修正。
- 根 `npm run typecheck` 9/9 通過。
- `npm run test:module -- shell-tools` 3/3：TS、43 unit、36 integration 通過，零 skip。
- `npm run test:module -- schedule-prompt` 3/3：TS、214 tests／14 files、離線真實 Pi 1.0.0 deadline probe 通過，零 skip。
- `npm run sources:verify`：195 snapshot hashes、94 adaptations、68 added files 與21 native files 驗證；5 個既有 historical-delta warnings 保留，不冒稱歷史 diff 等價。
- `npm run test:cross` 3/3：SDK hooks、provenance、manifest loaders 通過。新的真實 Pi 1.0.0 loader probes 驗證兩個實際註冊的 message renderers、收合／展開、欄寬1/2/12/24/80、控制安全與 content/details 不變。

分組理由：程式碼／TS 修改跑 unit/typecheck；兩模組功能跑各自 test:module；fixtures 與 provenance／多模組變更跑 test:cross。根單元先完成再執行其他重度驗證，避免 Subagents 300ms setup 競爭。README、configuration、provenance 已同步。

未執行全量 test:integration、test:package、test:browser、check、build（本次不發布／修改manifest/files，build原為no-op）；不算通過。未人工驗證使用者實際終端／fullscreen 操作。測試只用隔離 fixtures，無 paid provider 或真實設定／credentials 改動；renderer 不讀檔。工作目錄無.git，未commit／發布。重新 /reload 後生效（reload 沿用原有取消背景工作語意，宜等正在執行的工作結束）。

證據：`plan/evidence/{unit,typecheck,module-shell-tools,module-schedule-prompt,cross}.json` 及各組.log。新增 renderer 只影響 TUI；展開顯示通知已保留的內容，不恢復已丟棄輸出，Shell log仍僅保留前1 MiB。