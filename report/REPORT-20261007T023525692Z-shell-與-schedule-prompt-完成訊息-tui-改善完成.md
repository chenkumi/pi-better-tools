# Shell 與 Schedule Prompt 完成訊息 TUI 改善完成

## 交付

- Shell `shell-job-completed`：不再直接顯示 JSON。收合顯示狀態／exit code／耗時／命令、三行輸出預覽（優先尾端）、截斷與log；展開顯示 job ID、較完整命令與通知保留的 head/tail/error。包含 Error 字詞不會偽造失敗，缺有效 exit code 不偽造成功。
- Schedule `scheduled_prompt`：分辨開始、完成、失敗、略過與 inline 僅送達（不是完成）；三行結果／原因預覽，展開看 prompt／ID／保留結果。空結果及缺 details 的舊內容安全呈現；skipped 新增明確 details flag，精確舊 reason 仍支援。
- 只改顯示，不變更模型 content、followUp／triggerTurn、統計或工作 lifecycle；兩模組各自擁有 renderer，不新增 runtime 跨模組依賴。ANSI／OSC／控制／bidi 清理、Unicode 欄寬、多行拆分與300行上限。Renderer不讀log或執行工具；展開不恢復丟棄的輸出，Shell log仍只留前1 MiB。
- README／configuration／provenance 已同步。請等背景工作結束再 `/reload`，重新載入後才生效（reload 的原有取消工作語意不變）。

## 實際驗證

最終 sequential pipeline 成功：根 `npm test` 10/10 階段零失敗（File Tools 1個既有Windows平台skip不算通過）；根 TS 9/9；Shell module 43 unit＋36 integration、Schedule module 214 tests＋離線Pi1.0.0 host probe，兩模組各3/3通過／零skip；cross 3/3含實際loader註冊的兩個message renderers收合／展開、窄寬1/2/12/24/80、Unicode、安全與content/details不變斷言。新增專屬renderer測試為Shell10／Schedule8。根單元先結束再跑其他重度驗證，未重現前次任務的Subagents setup競爭。

source verification：195 snapshot hashes／94 adaptations／68 added files／21 native files；5項既有historical delta警告仍保留，不宣稱歷史diff等價。

Review兩項有效缺口（多行error及缺details舊訊息）已修正及補回歸，唯讀複查未發現新重要問題。首次專屬測試誤禁TUI自己的SGR reset，已改只允許SGR，其他cursor/OSC/C1/bidi仍禁止。reviewer僅靜態核對，無動態證據冒稱。

## 未執行與證據

未跑全量 integration/package/browser/check/build（build本為no-op），未人工驗證使用者終端／fullscreen操作；不算通過。未改真實settings/auth/排程，測試使用隔離fixtures與offline provider；無commit或遠端發布。

計畫與完整紀錄：`plan/PLAN-20261007T022044098Z-shell-與-schedule-prompt-完成訊息-tui-改善.md`。證據：`plan/evidence/{unit,typecheck,module-shell-tools,module-schedule-prompt,cross}.json`及各組log。