# File Tools：檔案工具、診斷與 FFF 搜尋

## 指令與工具

本模組提供 `read`、`write`、`edit`、`ls`，沒有自己的 slash 設定命令。`grep`／`find` 不由本模組註冊；整合包可由 `@ff-labs/pi-fff` override 提供。

- `read` 回傳絕對行號與 SHA-256 版本 token；有 continuation 時依 nextOffset 繼續讀。
- `edit` 先讀取檔案，使用最新 `expectedHash`；行號前綴不是檔案內容。
- `write` 用於新檔或明確整檔覆寫；新建可用 `expectedHash: "missing"`。
- `ls` 預設最多 500 筆；工具選取與排除仍交由 Pi。

## Config 與作用範圍

模組設定只讀全域 `<agentDir>/settings.json`，支援 `PI_CODING_AGENT_DIR`：

```json
{ "pi-file-tools": { "debugLog": false } }
```

預設 false；不採專案同名鍵。設定在 extension 載入時讀取，修改後 `/reload`。啟用診斷後存於 `~/.pi/logs/pi-file-tools/YYYY-MM-DD.jsonl`；文字 payload 主要記長度／hash，但路徑等欄位仍可能敏感，無自動保留期限。

`read` 圖片另沿用 Pi 的有效 `images.autoResize`（預設 true）：

```json
{ "images": { "autoResize": true } }
```

## FFF 共存設定（不是 File Tools 的設定鍵）

- `/fff-mode override` 後 `/reload` 切換目前 session；不改全域 config。
- 持久設定使用 `<agentDir>/pi-fff.json`：`{ "mode": "override" }`。
- 啟動選項 `--fff-mode` > 環境變數 `PI_FFF_MODE` > 檔案；恢復 session 的既有 mode 另可能優先於啟動設定。
- 整合薄入口只在以上來源都未指定時預設 override，不覆蓋明確的 tools-only／tools-and-ui，也不修改第三方程式。
- 設定後檢查目前 `grep`／`find` 的實際 provider 與 schema，不把 FFF 參數當宿主的同義名稱。不得為了測試而覆寫使用者真實檔案。
