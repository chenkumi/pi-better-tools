# Pi Runtime：deferred discovery 與共通指引

## 指令與工具

- 本模組沒有指令，也沒有額外模型工具；`tool_search` 是宿主能力，不是 Runtime 自己註冊的資料庫工具。
- 已移除 error recovery（`/runtime-recovery`、`/runtime-recover`）；不要建議使用者這些指令。

## Config 與作用範圍

**沒有公開的模組 JSON 設定鍵。** 不要捏造 `pi-runtime.enabled` 之類的鍵。

## Deferred 與提示的生效方式

全新 session 中有本專案 deferred 工具時，Runtime 會啟用已註冊的 `tool_search`；沒有該搜尋工具時，對已允許的本專案 deferred 工具做 startup 直接宣告 fallback。Resume／fork／reload 保留其工具集，不強制更改。

未載入 namespace 的短提示隨 active tool set 更新：PTY `pty`、排程 `schedule`、SQLite `sqlite`、SQL Connector `mysql`／`mssql`／`pgsql`。工具被 allowlist／exclude 排除時不能搜尋載入。

`pi_better_tools_cross_tool_rules` 依已選工具加入跨模組指引，無獨立設定鍵。停用整個 Runtime 應使用 package extension filter 排除 `modules/pi-runtime/src/index.ts`，同時會失去這些共用行為；不要只為拿掉一段提示而擅自停用整個 Runtime 或改全域設定。
