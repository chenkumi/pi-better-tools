# Subagents M4 重新開啟：transcript close 失敗被誤視為完成

日期：2026-10-08。來源：额外可靠性唯讀reviewer job `01m4ck4eq998w613pjsx5fg4za`；完整可採用輸出讀自 `C:/Users/KY6584/.pi/agent/subagent-sessions/01m4ck4es9z3dcaebs5q6kfd14/transcript.jsonl` 的2026-10-08T01:49:57.309Z assistant record。Reviewer未建立report（沒有note工具），未做故障注入。

## 查證與影響

Parent於重新開啟當時對照程式，靜態確認成立（以下保留原缺陷快照／行號，並非目前仍有相同缺口）：

- `modules/subagents/extensions/subagent/subsession-log.ts:435–443`：abandon先設定writeError，closeHandle把實際handle.close rejection捕捉後呼叫fail，卻不重新throw；??=亦隱藏了後來的close錯誤。
- `modules/subagents/extensions/subagent/index.ts:922–955`：一般／晚到清理都可能在close失敗後继续block/release；IoGate operation rejection本身不設定stopped，所以僅讓abandon reject不足以修好一般release guard。
- 尚未在parent進行新故障注入；此為獨立審查＋當前讀碼確認，不宣稱實驗重現。
- 原先實際已完成的unit/module/cross/package成功紀錄仍有效，但它們沒有覆蓋此close-rejection缺口，不代表此新缺陷不存在。M4暫時重新開啟，不能維持完整已修復判定。

## 修復授權與計畫

委派專屬worker job `01m4cm76r8x79ws1qwtdt9264s`、task `01m4cm76r8b18gttjdcfnh6p4m`：僅允許subsession-log/index、指定三個相關測試檔與README；parent負責root/provenance/checklist。要求：

1. 實際close失敗保持rejecting ownership barrier，保留primary與close diagnostics；正常finalize的structured error契約不擅改。
2. 一般與晚到清理都不在未確認close時release/rollback/ready。
3. 未立即await abandonment也立即附rejection handler，避免新增unhandled rejection。
4. 確定性writer close reject、一般／晚到runner lock retention與成功close回歸；可行時red-run再green，無固定sleep弱化。
5. 最終targeted＋subagents module分組；parent再更新provenance與cross/package evidence。

## 狀態

**此M4 close-rejection缺口已修復；2026-10-08第一階段獨立查證時發現本節狀態過期，現同步更正。** `subsession-log.ts` 已保留actual close rejection與primary／close diagnostics；一般與晚到清理不把rejecting ownership barrier當完成，不提前release／rollback／ready。`review-lifecycle.test.ts` 覆蓋normal／write-failure／late／late-create四種close-failure路徑，並保留成功close／late-release回歸。

- 後續驗證快照：`report/REPORT-20261008T030808255Z-subagent-與-shell-英文訊息套用.md`、`report/REPORT-20261008T051850208Z-rpc-啟動失敗訊息與診斷補強交付.md`、`report/REPORT-20261008T065714430Z-subagent-建立-訊息統一實作與最終驗證.md`；最後一份記錄Subagents 299 unit＋49 offline Pi 1.0.0 integration、cross 3/3及package 19/19。這些是對應後續快照的證據，不重標原先tarball／測試為已覆蓋當時缺口。
- 本次current-source獨立唯讀查證：`report/REPORT-20261008T075605060Z.md`。沒有為本節文件更正新增產品測試；第一階段新碼的驗證尚未完成。
- 另一筆 `writer.lock` EPERM／ENOTEMPTY暫存清理問題仍獨立開放：`issue/ISSUE-20261008T024541630Z-subagents-abort-回歸測試暫存-writer-lock-清理失敗.md`。本M4關閉不宣稱其歷史根因已修復，也不強刪close失敗的live lock。