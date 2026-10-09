# Control accepted／queued 提示文字修正與驗證

## 使用者要求
將 `Accepted/queued is not applied` 改為接近實際狀態、避免誤認成錯誤的說明。

## 已完成
- `modules/subagents/extensions/subagent/background-renderer.ts`：accepted 顯示「控制訊息已受理，等待納入子代理對話」；queued 顯示「控制訊息已排入佇列，等待納入子代理對話」。
- 保留原始 status 值、applied／not_applied／delivery_unknown、權威狀態色彩及處理流程；不修改 schema、工具描述、信任邊界或通知喚醒。
- `modules/subagents/tests/background-renderer.test.ts`：覆蓋收合／展開、工具／訊息兩種 renderer，確認新說明、舊措辭消失、等待狀態中性圖示與真正錯誤／未知送達狀態保持不變。
- `modules/subagents/README.md`：同步說明提示與 applied 只代表納入對話，不代表要求的工作完成。
- 更新已檢閱三個檔案的 provenance，保留 immutable sources 與歷史限制。

## 已執行驗證
- renderer 針對性回歸：17/17 通過，無 skip。
- `npm run sources:verify`：通過目前本地雜湊檢查；43 項歷史差異缺原內容的既有警告保留，不宣稱歷史等價。

## 背景驗證（尚未取得結果，不算通過）
依序執行 `npm test`（程式碼變更基本檢查）、`npm run test:module -- subagents`（模組檢查）、`npm run test:cross`（provenance 變更）。

- jobId：`01m4cnbdbydbgv2pzz91tqgctm`
- log：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-MgirBq/output.log`

## 未執行／生效
本次未另跑完整 root integration、package、check 或手動真實 TUI 驗證；不沿用先前快照為本次新修改的通過證據。等待背景工作全部完成後 `/reload` 生效；原始歷史訊息不重寫。
