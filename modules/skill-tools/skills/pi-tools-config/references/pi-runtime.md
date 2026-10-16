# Pi Runtime：恢復、deferred discovery 與共通指引

## 指令與工具

- `/runtime-recovery status` 查看目前恢復狀態。
- `/runtime-recovery off`／`on` 切換目前 session／branch 偏好。
- `/runtime-recover <用途與範圍澄清>`：idle TUI 中、經互動確認後提交有限診斷恢復；RPC／JSON／print 拒絕此手動流程。
- 本模組沒有額外模型工具；`tool_search` 是宿主能力，不是 Runtime 自己註冊的資料庫工具。

## Config 與作用範圍

**沒有公開的模組 JSON 設定鍵。** on/off 保存於目前 session／branch 的自訂狀態，不寫個人 settings，也不重置每個可辨識使用者任務最多兩次的恢復額度。不要捏造 `pi-runtime.enabled` 或增加重試次數的鍵。

預設 error-aware recovery 只處理明確可修正的輸入／工具 JSON 錯誤；網路、配額、overflow 等沿用宿主。Policy／cyber／未知錯誤不自動恢復；澄清不是放行、工具權限或繞過 safeguard 的授權。需要可持久化 session 及相同模型，no-session 不自動恢復。

## Deferred 與提示的生效方式

全新 session 中有本專案 deferred 工具時，Runtime 會啟用已註冊的 `tool_search`；沒有該搜尋工具時，對已允許的本專案 deferred 工具做 startup 直接宣告 fallback。Resume／fork／reload 保留其工具集，不強制更改。

未載入 namespace 的短提示隨 active tool set 更新：PTY `pty`、排程 `schedule`、SQLite `sqlite`、SQL Connector `mysql`／`mssql`／`pgsql`。工具被 allowlist／exclude 排除時不能搜尋載入。

`pi_better_tools_cross_tool_rules` 依已選工具加入跨模組指引，無獨立設定鍵。停用整個 Runtime 應使用 package extension filter 排除 `modules/pi-runtime/src/index.ts`，同時會失去這些共用行為；不要只為拿掉一段提示而擅自停用錯誤恢復或改全域設定。

先用 status 與目前工具目錄診斷；不為測試恢復而刻意發送付費失敗請求。
