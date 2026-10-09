# 兩份 session 的 Subagent 呼叫與回饋唯讀稽核

## 任務與邊界
使用者要求確認以下兩份對話紀錄的 Subagent 呼叫與回饋是否運作正常：
- `C:/Users/KY6584/.pi/agent/sessions/--D--GitHub-pi-better-tools-main--/2026-10-08T01-34-03-224Z_01a11925-63d7-775d-b2fa-1983e71a8026.jsonl`
- `C:/Users/KY6584/.pi/agent/sessions/--D--projects-smart-reports--/2026-09-09T02-43-36-650Z_01a0840c-a649-7187-9677-06aaf1ac515b.jsonl`

2026-10-08開始唯讀稽核，不執行原命令、不啟動新child／真實provider、不改settings/auth、來源session或產品程式碼。日期採檔案內實際事件時間；檔名日期只代表session起始，不能視為所有事件日期。

## 檢查順序
1. 串流讀取全部JSONL，记录SHA256／大小、解析狀況、事件日期範圍與Subagent相關呼叫、tool result、custom notification結構。
2. 依toolCallId／jobId／taskId對應dispatch、foreground完成、background task_result、control/query/cancel；accepted／queued／applied不混同為工作完成，歷史快照不当成當前狀態。
3. 對失敗、缺回覆、重複／矛盾回饋候選，追查紀錄提供的managed child log／run metadata；必要時唯讀現有實作核對語意，避免以当前code证明歷史等價。
4. 保存報告，列出正常、實際失敗、待驗證項、證據位置與限制。避免輸出完整prompt、憑證或個資。

## 已完成（2026-10-08 UTC）
- 第一份固定稽核前8,399,509 bytes／1,104行，前綴SHA256重驗相同；第二份全部117,551 bytes／53行；解析錯誤均0。
- 第一份6次background派遣共12task，11 completed、1 RPC startup failed；20個Subagent相關toolCall／toolResult完整一對一配對。
- 10 accepted controls在canonical native user訊息完整exact match且每筆一次；2次TASK_NOT_RUNNING均對已終結task送訊息，拒絕合理。1 query完成，snapshot entry存在、主線user未納入query。
- 12組managed metadata／readable log核對完成，11個ready checkpoint的native bytes／SHA256及readableCommittedBytes吻合，現時無writer.lock；不據此保證process tree已停止。
- 通知延遲與parent stop後followUp入檔模式一致，不把通知時間當child完成時間；缺enqueue歷史，不能重建全部耗時原因。
- 保留回饋缺口：1筆獨立control_result未在parent出現但最終applied與native證據存在；8個完成短摘要為早期進度；2個reviewer明示無note工具而未產出報告檔。
- 第二份僅2026-09-09 Sybase匯入，7 read／13 bash，無Subagent案例；需使用者提供正確smart-reports近期session。
- Audit-only相對native路徑與PowerShell中文regex stdin編碼問題已修正，所需分析重跑完成；未把失敗分析計為通過。

## 交付與未覆蓋
報告：`report/REPORT-20261008T054254050Z-兩份-session-的-subagent-呼叫與回饋稽核結果.md`。
未修改產品、來源session、managed資料或真實settings/auth；未跑npm／module／cross／package測試、真實child／provider或TUI。沒有同步／chain／resume／cancel案例，不能宣稱已覆蓋。RPC原始根因與缺獨立通知原因仍未確認，未授權修復。
