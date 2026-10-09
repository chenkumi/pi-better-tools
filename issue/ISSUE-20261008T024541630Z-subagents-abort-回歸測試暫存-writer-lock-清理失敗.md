# Subagents abort 回歸測試暫存 writer.lock 清理失敗

## 狀態
根因未修復，保留追蹤。前序根單元9/10與隔離重跑失敗；英文訊息套用後的新輪root unit10/10、Subagents3/3及後續再跑root unit10/10通過，但沒有針對此清理問題的修補。不可直接歸類為偶發環境問題，也未證明是production ownership缺陷。

## 證據
- 背景驗證 job `01m4cnw7m95tjwas92xmdqjsz3`：provenance 更新完成，`npm test` 9/10 stages 通過，Subagents unit 失敗；因串接命令遇到非零退出即停止，此輪 cross 未執行。
- 失敗案例：`modules/subagents/tests/runner.test.ts` 的 `parent abort wins when it precedes inactivity timeout`。
- 原失敗：`EPERM`，刪除暫存 managed session 的 `writer.lock` 時失敗。
- 保留原 log：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-cmHoFo/output.log`；原階段結果：`plan/evidence/unit.json`。
- 隔離重跑命令：`node --import tsx --test --test-concurrency=1 --test-name-pattern=parent.abort.wins.when.it.precedes.inactivity.timeout modules/subagents/tests/runner.test.ts`。
- 隔離結果：1 case／0 pass／1 fail，`ENOTEMPTY`，仍是暫存 `writer.lock` 刪除失敗。未修改或跳過測試，不能用此前通過結果覆蓋。

## 初步定位與限制
`runner.test.ts:23–83` 共用 run helper 在 finally（82行）直接 recursive rm 測試 root。它有觀察 prompt 目錄刪除完成，但不等同已確認所有晚到 managed/native I/O 收尾。若取消發生在 invocation 前，taskPath 可能未設定，也不走 prompt deletion 等待。

這提供測試 teardown 與晚到 ownership/I/O 重疊的調查方向，不足以直接判定根因。後續應以實際 lifecycle 證據定位；不得盲目刪除 live writer lock、放寬狀態斷言、增加固定 sleep 或宣稱取消等於資源終止。

## 已独立驗證的不同範圍
在隔離案例失敗後，仍独立執行 `npm run test:cross`：3/3 stages 通過，包括 SDK hooks、provenance、7個真實 Pi 1.0.0 loader variants／renderer assertions，無 skip。

這證明前序 control 文案 cross fixture 修補已通過，不表示 abort 案例或完整單元通過。完整root integration／package／check未另執行。

## 建立此issue當時的修改與使用者範圍
此輪沒有修改產品程式或測試；僅調查、重跑並記錄。使用者目前要求的是英文訊息建議比較表，尚未授權本表全面實作。本問題保留待修，當時英文建議尚未套用程式。

## 後續驗證（不是根因修復）
使用者後續已授權英文訊息套用；該工作沒有調整run helper的清理、ownership或取消斷言。新job `01m4cqx28reqs2h0ken0vmwwzq` 的root unit10/10、Subagents3/3通過，後續Shell顯示修正再跑root unit亦10/10通過；本案例沒有skip。原EPERM／ENOTEMPTY歷史失敗仍成立，issue不因此關閉。

- 歷史失敗證據保留在上述原log；`plan/evidence/unit.json`是最新結果，已非前序失敗snapshot，不得回指成原輪證據。
- 新輪log：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-9nKvb0/output.log`。
- 後續root unit通過log：`C:/Users/KY6584/AppData/Local/Temp/pi-powershell-e59c72db67146c85.log`（含後續Shell/cross工作，cross在該log當時仍有舊label斷言失敗；與本issue不同）。
- 最新stage證據：`plan/evidence/unit.json`、`plan/evidence/module-subagents.json`。不從單次或數次通過推論根因已消失。
