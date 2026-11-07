---
name: os-scheduling
description: Use when a task must run on a schedule even while Pi is closed, or when the user asks to set up, inspect, or remove an OS-level scheduled task (Windows Task Scheduler, cron, systemd timer, launchd) that runs pi unattended.
---

# 作業系統層排程（Pi 關閉後仍要執行）

`schedule_prompt`／`schedule_shell` 只在 Pi session 開著時觸發，Pi 關閉就不執行。需要「Pi 沒開也要跑」時，改用作業系統的排程器啟動無人值守的 `pi -p`。本專案**不提供** OS 排程工具；本技能只是文件，不執行任何東西。

## 先判斷要不要用 OS 排程

- 只要 Pi 開著時提醒或定時執行：用 `schedule_prompt`／`schedule_shell`，不要建 OS 任務。
- 需要關機重開後仍存在、或與 Pi 是否開著無關：才用 OS 排程。
- OS 排程會在使用者電腦上留下持續存在的副作用（定時執行、可能呼叫付費模型）。建立前先說明內容並取得使用者明確同意，建立後告知任務名稱與移除方式。不要為了「測試」而建立真實排程。

## 無人值守的 `pi -p`

核對過 `pi --help`（Pi 1.5.0）的旗標：

- `-p`／`--print`：非互動，處理 prompt 後結束。
- `--no-session`：不保存 session（一次性任務）；要保留紀錄則用 `--session-dir <dir>` 指定專屬目錄。
- `--tools <清單>` 或 `--no-tools`：限縮可用工具。無人值守時只給任務需要的工具，不要給 shell 或寫檔，除非任務本身需要。
- `--approve`：本次執行信任專案本地檔案（專案 settings、extensions、`.pi/` 設定）。**預設不要加**；只對你確認內容的專案加，因為這等於讓該專案的設定在無人看管時生效。
- `--model <provider/id>`：明確指定模型，避免依賴互動時的預設；`--offline`：關閉啟動時的網路動作。
- `--mode json`：輸出機器可讀的事件，方便排程器之外的腳本解析。

必須處理的環境差異（排程器的環境通常比互動 shell 乾淨）：

1. **工作目錄**：排程器的預設 cwd 不是專案。每個範例都明確切到專案目錄。
2. **憑證**：Pi 的登入憑證在使用者層。以該使用者身分執行，不要用 SYSTEM／root；先用 `pi auth --help` 的子命令確認 provider 已就緒。不要把 API key 寫進任務定義或命令列。
3. **PATH**：排程器可能找不到 `pi`、`node`。使用絕對路徑，或在包裝腳本內設定。
4. **輸出與日誌**：排程器不會保存輸出。把 stdout／stderr 導向有日期的日誌檔，放在專案之外或已被 gitignore 的目錄。
5. **失敗通知**：`pi -p` 失敗時退出碼非 0。在包裝腳本檢查退出碼並通知使用者（寫日誌、寄信、或使用者自己的通知管道）；沒有通知就等於沉默失敗。
6. **重疊與逾時**：上一次還沒結束就又觸發會疊加。用鎖檔或排程器的「不重複執行」選項，並設定逾時。
7. **費用**：每次觸發都會呼叫模型。告知預估頻率與模型，必要時用較便宜的 `--model`。

## 平台範本（範本，使用前依實際路徑修改並先小範圍驗證）

以下指令未在本專案測試環境實跑；執行前讓使用者看過完整命令。任務名稱統一加 `pi-` 前綴，方便查詢與移除。

### Windows（Task Scheduler）

建立（每天 09:00，在專案目錄執行包裝腳本）：

```powershell
schtasks /Create /TN "pi-daily-review" /SC DAILY /ST 09:00 /TR "powershell -NoProfile -File C:\path\to\run-pi-task.ps1"
```

包裝腳本 `run-pi-task.ps1`：

```powershell
Set-Location C:\path\to\project
$log = "C:\path\to\logs\pi-daily-review-$(Get-Date -Format yyyyMMdd).log"
& "C:\path\to\pi.cmd" -p --no-session --model provider/id "你的 prompt" *> $log
if ($LASTEXITCODE -ne 0) { Add-Content $log "exit code $LASTEXITCODE" }
```

查詢與移除：

```powershell
schtasks /Query /TN "pi-daily-review" /V /FO LIST
schtasks /Delete /TN "pi-daily-review" /F
```

### Linux（cron）

```sh
crontab -l                      # 先看現有內容
( crontab -l 2>/dev/null; echo '0 9 * * * cd /path/to/project && /path/to/pi -p --no-session --model provider/id "你的 prompt" >> /path/to/logs/pi-daily.log 2>&1' ) | crontab -
```

移除：`crontab -e` 刪除該行（不要用會清空整個 crontab 的 `crontab -r`）。cron 的環境變數極少，必要時在命令前明確設定 `PATH`。

### Linux（systemd user timer）

`~/.config/systemd/user/pi-daily.service` 與 `pi-daily.timer`（timer 內 `OnCalendar=*-*-* 09:00:00`，service 內 `WorkingDirectory=`、`ExecStart=`）：

```sh
systemctl --user daemon-reload
systemctl --user enable --now pi-daily.timer
systemctl --user list-timers pi-daily.timer     # 查詢
journalctl --user -u pi-daily.service           # 日誌
systemctl --user disable --now pi-daily.timer   # 移除；再刪除兩個 unit 檔
```

### macOS（launchd）

在 `~/Library/LaunchAgents/` 放 `com.example.pi-daily.plist`（`ProgramArguments`、`WorkingDirectory`、`StartCalendarInterval`、`StandardOutPath`／`StandardErrorPath`）：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.pi-daily.plist
launchctl print gui/$(id -u)/com.example.pi-daily        # 查詢
launchctl bootout gui/$(id -u)/com.example.pi-daily      # 移除；再刪除 plist
```

## 完成後要告訴使用者的事

- 任務名稱、觸發時間、執行的完整命令與使用的模型。
- 日誌位置與如何得知失敗。
- 移除指令（上方對應平台）。
- 這不是 sandbox：無人值守的 `pi` 會用該使用者的權限操作專案與檔案。
