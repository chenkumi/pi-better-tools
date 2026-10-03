# Shell Tools

覆寫 Pi 內建的 `bash` 與 `powershell` 工具，將以秒為單位的 `timeout` 改為以毫秒為單位的「輸出停滯逾時」`timeoutMs`。其餘行為（輸出處理、renderer、session 環境、PowerShell UTF-8、Bash `shellPath`／`shellCommandPrefix`）沿用 Pi 內建實作。

## 工具

兩個工具共用相同 schema（不允許額外欄位）：

| 參數 | 型別 | 說明 |
|---|---|---|
| `command` | string（必填） | 要執行的 shell 指令 |
| `timeoutMs` | integer（選填，1 ～ 2147483647） | 輸出停滯逾時，單位毫秒 |

- `bash`：使用 Pi 的平台 shell 解析；Windows 需安裝 Git Bash 或設定 `shellPath`。
- `powershell`：僅支援原生 Windows；其他平台即使有 `pwsh` 也不提供此後端。不套用 Bash 的 `shellCommandPrefix`。

兩者皆以 `defaultActive: false` 註冊：載入本擴充不會啟用未被選取的 shell，是否啟用由 Pi 預設 loadout、`defaultTools`、`--tools`、排除設定或 `setActiveTools()` 決定。

## timeoutMs 行為

| 輸入 | 效果 |
|---:|---|
| `20000` | 連續 20 秒沒有輸出即停止 |
| `120000` | 連續 120 秒沒有輸出即停止 |
| `2147483647` | 不逾時（哨兵值，不啟動計時器） |
| 省略 | 不逾時 |

- 計時於 shell 開始執行時啟動，每收到一個 stdout／stderr 資料區塊即重新計時；只有輸出停滯達該時間才會逾時。持續有輸出的指令可執行超過 `timeoutMs`。
- Pi 內建的絕對計時器對此覆寫停用。內部以 `timeout:<秒數>` 丟出，宿主會格式化為 `Command timed out after N seconds`；本擴充改寫為 `Command stopped: no output for N seconds (timeoutMs idle timeout)`，以符合「輸出停滯」語意。
- PowerShell 工具的宿主選項不支援 `shellPath`／`shellCommandPrefix`，這兩項設定僅套用於 Bash。
- 非正數、小數、非安全整數、超過上限的值會被拒絕。
- 新的呼叫若帶舊版 `timeout`（秒）欄位會直接報錯，請改用 `timeoutMs`；舊 session 紀錄中的 `timeout` 仍可正常顯示。
- TUI 以秒顯示（例如 `timeout 20s`）。
- 省略或使用哨兵值不會停用取消：`AbortSignal` 仍會交由 Pi 的 process tree 終止機制處理。逾時只是停滯門檻，不保證啟動與清理在該時間內完成。

### Codemode

```javascript
const result = await tools.bash({ command: "printf hello", timeoutMs: 20000 });
text({ output: result.output, exitCode: result.exit_code });
```

Windows 上可用 `tools.powershell({ command, timeoutMs })`。該 shell 必須已被選取，載入本擴充不會自動讓 codemode 可用。

## Bash 設定

每次執行 Bash 時透過 `pi.getSettings()` 讀取宿主的有效設定（全域、受信任的專案設定與 SDK 記憶體覆寫）：

| 設定鍵 | 說明 |
|---|---|
| `shellPath` | Bash 執行檔路徑；沿用 Pi 對 `~`、file URL、Windows 磁碟路徑的正規化 |
| `shellCommandPrefix` | 加在每個 Bash 指令前的前綴 |

本模組不會自行重讀設定檔。修改持久化設定後請使用 Pi 的 `/reload`（或嵌入式宿主呼叫 `settingsManager.reload()`）；SDK `applyOverrides()` 的變更在下次執行時生效。

## 失敗除錯日誌（選用，預設關閉）

在 `~/.pi/agent/settings.json` 加入：

```json
{
  "pi-shell-tools": {
    "debugLog": true
  }
}
```

- 只有字面布林值 `true` 會啟用。每次失敗時才讀取此檔，修改後不需 `/reload`。
- 開關固定讀取使用者家目錄下的 `~/.pi/agent/settings.json`；專案設定、SDK 覆寫與 `PI_CODING_AGENT_DIR` 都不會改變開關或日誌位置。檔案不存在、無法讀取、JSON 無效或非一般檔案時視為關閉。
- 本模組的 `bash`／`powershell` 執行拋出例外（含逾時、取消、輸入驗證錯誤）或回傳 `isError: true`（例如非零結束碼）時，每次失敗寫入一個檔案：

```text
~/.pi/logs/pi-shell-tools/<UTC時間戳>-<ULID>.json
```

- 內容（`schemaVersion: 1`）包含：時間戳、process id、工具名稱、toolCallId、cwd、sessionId、耗時毫秒、原始輸入（含 `timeoutMs`），以及例外（name／message／stack／cause）或失敗結果。字串超過 65,536 字元時保留前後各 32,768 字元並加上省略標記，原始輸入／結果不受影響。
- 成功呼叫不產生日誌。診斷 I/O 的等待上限為 2 秒，寫入屬 best-effort，失敗最多警告，不改變原本的工具結果或例外。
- 日誌可能包含指令與含機密的輸出；不會自動輪替或清理，請自行刪除。POSIX 上新檔／目錄要求 `0600`／`0700`，Windows 依檔案系統 ACL。本模組不會自動修改你的設定來啟用日誌。

## 範圍與限制

- 只改變模型可呼叫的 shell 工具，不影響 `!`／`!!` 使用者 shell 指令或 `pi.exec()`。
- 同名 shell 工具應只由一個擴充擁有；本模組不會與 SSH、sandbox 或 spawn-hook 覆寫自動組合，也不保證保留其執行限制，不要把載入順序當作安全邊界。
