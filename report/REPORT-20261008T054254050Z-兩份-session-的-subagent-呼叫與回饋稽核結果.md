# 兩份 session 的 Subagent 呼叫與回饋稽核結果

## 結論
2026-10-08唯讀稽核：第一份的派遣、呼叫配對、控制訊息納入、query回覆、managed持久化與終結回報大致正常，但不是所有task皆成功：12個task中11個completed、1個reviewer RPC startup失敗。另有一筆獨立control_result通知未在parent紀錄出現、8個成功task的精簡完成摘要取到了早期進度，以及2個reviewer沒有note工具而無法產出要求的報告檔。這些應與執行器故障分開判斷。

第二份完整紀錄只涵蓋2026-09-09的Sybase資料匯入，沒有Subagent呼叫或回饋，不能用它驗證smart-reports的Subagent運作。它不是先前2026-10-08統計頁驗證工作的對話紀錄。

## 範圍與檔案基準
### Session A
`C:/Users/KY6584/.pi/agent/sessions/--D--GitHub-pi-better-tools-main--/2026-10-08T01-34-03-224Z_01a11925-63d7-775d-b2fa-1983e71a8026.jsonl`

- 初次讀取：8,399,509 bytes／1,104行；JSONL解析錯誤0。
- SHA256：`a87b7f04ebc238500e8a60d68f15b538f12d7d4fd130b0566c1ff885470b5173`。
- 事件範圍：2026-10-08T01:34:03.224Z至2026-10-08T05:33:20.472Z。
- 此為目前仍會append的session；後續分析固定於前8,399,509 bytes／1,104行，並重新核對此前綴SHA256相同。不宣稱整個live檔案一直未變。

### Session B
`C:/Users/KY6584/.pi/agent/sessions/--D--projects-smart-reports--/2026-09-09T02-43-36-650Z_01a0840c-a649-7187-9677-06aaf1ac515b.jsonl`

- 117,551 bytes／53行；JSONL解析錯誤0。
- SHA256：`cfb3e131fe7ce4eda0d2c482f370e606d8a3a1bc49af9837460d2316151f8c7f`。
- 事件範圍：2026-09-09T02:43:36.650Z至2026-09-09T03:14:32.802Z。
- 7次read、13次bash；Subagent相關toolCall、toolResult、custom notification均0。沒有compaction或context_edit事件。已讀取全部53行，不是因畫面摘要漏掉呼叫。

## Session A：量化核對
| 項目 | 結果 |
|---|---|
| subagent工具派遣 | 6次，全部background:true；1批7個worker＋5次single，共12個task |
| 其他管理／互動工具 | subagent_message 13次：12 control＋1 query；subagent_status 1次 |
| toolCallId配對 | 20 calls／20 results，無缺result、孤兒result或重複result |
| task_result | 6筆batch／job完成通知，覆蓋12個task，無重複終結task |
| 權威task outcome | 11 completed／exit0，1 failed／exit1；parent通知與各自run.json的status、exitCode、subagentSessionId均一致 |
| log_ready | 23筆；成功task通常有log建立及interactive可用兩種快照，失敗startup task只有初期log快照。不等於23次child派遣 |
| Control受理 | 10 accepted、2 TASK_NOT_RUNNING拒絕 |
| Control实际納入 | 10/10在各自canonical native user訊息中出現恰好1次，完整前綴＋原文exact match；最終receipt均applied |
| 獨立control_result | 9筆applied；另一筆只在task_result的controls欄位看到applied，詳見SA-AUDIT-002 |
| Query | 1 accepted／1 completed query_result，最終receipt一致，cleanupPending:false |
| 持久化現況 | 11成功session為ready；native bytes／SHA256與checkpoint全數吻合，readableCommittedBytes亦吻合；12個session現時皆無writer.lock目錄。此為當前磁碟觀察，不保證process tree已終止 |

### 派遣／終結索引
| 目標 | taskId | outcome | Parent通知行 |
|---|---|---|---|
| 初始Subagents修復 | 01m4cjdns21ac6v5rh9702w7r3 | completed | A:353 |
| File-tools | 01m4cjdns238yyp5z4v3w44yg0 | completed | A:353 |
| Web-tools | 01m4cjdns2p3ds039bjdj87wmw | completed | A:353 |
| Schedule Prompt | 01m4cjdns2bdt9s4bx69vzbsj6 | completed | A:353 |
| PTY | 01m4cjdns2f0xmm3wjn6rrck43 | completed | A:353 |
| JSON Schema | 01m4cjdns3r64fa2zwxqyzjfap | completed | A:353 |
| Note／GPT Speed | 01m4cjdns38dvtnhdnyge73t81 | completed | A:353 |
| 第一個reviewer | 01m4cjj1383dse0fffth9tjtnb | failed | A:301 |
| Reliability reviewer | 01m4ck4eq902qzb7960xvm4c0z | completed | A:319 |
| Writer close修復worker | 01m4cm76r8b18gttjdcfnh6p4m | completed | A:380 |
| 英文訊息reviewer | 01m4cpn8y5y0nsgqkpa5j7wqsv | completed | A:747 |
| RPC診斷reviewer | 01m4cwkac9rap9ee545myfvzpn | completed | A:1076 |

## 真正失敗與回饋缺口
### SA-AUDIT-001 — Reviewer RPC startup失敗
- 嚴重度：Medium（單一審查未執行，不能採用其結論）；確認狀態：失敗已確認／產品根因未確認；驗證結果：已觀察。
- A:67–68派遣受理，A:71初期log_ready；A:301誠實回報failed，沒有把queued受理誤當工作成功。
- jobId `01m4cjj138zhd6x1awahpj6ted`；taskId `01m4cjj1383dse0fffth9tjtnb`；session `01m4cjj18decktvzab17g4dvq2`。
- errorMessage：`RPC startup failed: RPC_DEADLINE: get_state response not received`；exitCode1、turns0、tokens0、canResume:false。
- `C:/Users/KY6584/.pi/agent/subagent-sessions/01m4cjj18decktvzab17g4dvq2/runs/01m4cjj1383dse0fffth9tjtnb/run.json`記錄blocked；manifest.updatedAt為2026-10-08T01:38:33.488Z；readable transcript為空，run資料夾無startup.json。
- `COMMIT_FAILED`是外層儲存fallback，不證明commit()本身被呼叫後失敗。此為先前已調查的同一次事件，不是新發現第二次startup failure，也不能以本次查核宣稱已修復根因。
- 已有調查：`report/REPORT-20261008T040244976Z-指定-subagents-rpc-啟動失敗紀錄調查.md`。

### SA-AUDIT-002 — 一筆獨立Control回饋未入parent紀錄
- 嚴重度：Low（可觀測性）；確認狀態：缺獨立事件已確認／原因待驗證；驗證結果：已觀察，不等於控制訊息未送達。
- messageId `01m4cjfywnhhfjxza4apxmmr5c`，taskId `01m4cjdns21ac6v5rh9702w7r3`。
- A:57有accepted receipt；在A的既定完整前綴中，這個ID僅出現在A:57與A:353，沒有對應獨立control_result custom message。
- A:353的最終controls明確applied；child `01m4cjdntkjfs45c256y1vpxds` readable user紀錄第47行含該前綴；native user entry完整原文exact match且只出現一次。
- 因此已排除「僅受理但從未進入canonical子對話」；但沒有通知enqueue／clearQueue／delivery acknowledgment歷史，不能斷言是host排隊遺失、renderer、callback或歷史實作分支造成。
- 目前README明列通知不保證exactly-once／送達確認；不能以當前source替歷史缺失指定根因，仍應保留此回饋缺口。

### SA-AUDIT-003 — 完成摘要取到早期進度，不是最終結論
- 嚴重度：Low（呈現）；確認狀態：已確認觀察；是否需要改行為待使用者決策。
- A:353的7個worker與A:380的writer-close worker，共8個completed task的模型精簡output首行含「我會補齊／我先新增…」等初期進度，而詳細output及完整log已含最終驗證與交付結論。
- 未確認任何status失真、輸出遺失或任務重啟；問題是「完成通知的短摘要」不能可靠代表最後答案。
- 當前`modules/subagents/extensions/subagent/index.ts:1151`確實以firstLineSummary(result.output,512)生成模型通知；目前只是核對呈現規則，不是保證整個歷史runner與当前完全等價。
- 使用者若要改進，可另行授權討論「保留完整進度，但完成摘要選最後有效assistant結論」；本次未修。

### SA-AUDIT-004 — Reviewer報告要求與可用工具不一致
- 嚴重度：Low（委派契約／交付）；確認狀態：兩個reviewer回覆明示限制已確認；不認定為runner執行失敗。
- A:192要求可靠性reviewer以note保存詳細報告；其最終assistant說本回合未提供note，沒有繞過限制寫檔。最終回饋仍在A:319及`C:/Users/KY6584/.pi/agent/subagent-sessions/01m4ck4es9z3dcaebs5q6kfd14/transcript.jsonl`。
- A:601允許英文訊息reviewer以note(report)保存；其最終assistant同樣明示note不可用、報告未建立。回饋在A:747及child `01m4cpn8zrmgy54mgf93ek25ce`的transcript。
- 當前modules/subagents/README.md:185列reviewer工具read／grep／find／ls／bash，未包含note，與上述回覆相符；未以當前agent catalog冒充歷史tools清單。
- Completed表示runner順利結束，不代表指定報告檔一定建立。後續委派應只要求回傳審查內容，由parent保存note，或另行明確設計reviewer工具權限；本次未擴權。

## 延遲通知與拒絕為何不矛盾
所有時間為2026-10-08 UTC。run.completedAt與parent custom_message的入檔timestamp是不同事件，差值不是模型或工具耗時：

| 事件 | 持久化完成／失敗更新 | Parent通知入檔 | 差值 |
|---|---|---|---|
| 失敗reviewer | manifest updated 01:38:33.488 | A:301 02:03:30.256 | 約24分57秒；此列不是run.completedAt |
| Reliability reviewer | run.completedAt 01:50:15.969 | A:319 02:04:34.929 | 約14分19秒 |
| 7-worker batch | 最後task completedAt 01:55:10.134 | A:353 02:08:41.608 | 最後task後約13分31秒；早完成task另含等待batch其他task的時間 |
| Writer-close worker | run.completedAt 02:15:56.299 | A:380 02:15:56.340 | 約0.041秒 |
| 英文訊息reviewer | run.completedAt 02:51:32.892 | A:747 03:08:20.917 | 約16分48秒 |
| RPC診斷reviewer | run.completedAt 04:34:46.862 | A:1076 05:20:58.307 | 約46分11秒 |

- A:294、746、1075均為parent assistant stop，緊接A:295、747、1076等followUp開始入檔／觸發後續回應。
- 當前extension `index.ts:1154–1155`使用followUp＋triggerTurn；本地host agent-session.js的sendCustomMessage在isStreaming時把followUp放入agent queue。workspace及已安裝release兩份source均有此分支。這與觀察的延遲符合，但historical callback enqueue時間未保存，不能把每秒差值全部歸因於單一排隊原因。
- A:150–151於01:44:39向已在01:38:33失敗的reviewer送control，TASK_NOT_RUNNING拒絕合理。
- A:1052–1053於05:04:56向已在04:34:46完成的RPC診斷reviewer送control，同样拒絕合理，即使完成通知要到05:20:58才入檔。
- 沒看到通知不代表child仍running；舊canMessage:true／queued／accepted receipt是當時快照。通知入檔晚也不代表child在那段時間持續執行。

## Query核對
- A:101–102受理query `01m4cjnpan95ap10211qg92jvj`，A:309回completed。
- asOf來源時間2026-10-08T01:39:55.630Z、capturedAt 01:40:00.991Z，來源entryId在child canonical native檔存在。
- 未在child native主線user訊息發現該query原文或queryId；符合一次性查詢不提交主線user prompt的契約。不是宣稱已全面驗證provider isolation。
- `stale:false`描述擷取當下安全prefix，不代表02:04收到答案時仍最新。A:310的parent回應正確說明它是01:39:55 UTC較早快照，沒有拿舊query覆寫最終完成結果。

## 實際驗證、工具阻礙與未覆蓋
- 已執行：兩份JSONL完整解析／bounded-prefix hash重驗、20工具呼叫配對、6完成通知／12task交叉核對、12組manifest／run／readable檢查、11個native checkpoint bytes／SHA256檢查、10控制訊息canonical exact match／單次出現、1query來源entry與主線user隔離檢查、關鍵parent stop／notification時間對照。
- audit輔助程式曾有兩個失敗：一次漏把manifest.nativeFile相對路徑resolve到child目錄，導致audit本身ENOENT；一次PowerShell stdin pipe將中文regex變成??，導致audit本身SyntaxError。兩者分別以正確child路徑與ASCII-only程式修正，後續所需查核完成。不是原session的Subagent故障，也未忽略失敗後將未執行分析算通過。
- 未執行npm test、test:module、test:cross、test:integration或test:package，因本任務僅唯讀紀錄稽核，沒有產品修改；未重跑真實child／provider、手動TUI、OS process-tree／remote API取消探針。
- A沒有同步Subagent、chain、resume、subagent_cancel案例；不能從本次推論這些模式已驗證。沒有獨立原始wire／enqueue／delivery acknowledgment歷史，不能證明恰好一次通知或重建每個歷史因果。
- 本次沒有重驗子代理聲稱的所有功能／測試成果；completed只確認runner outcome，不是全面審查品質認證。
- 未修改來源session、managed child資料、兩個專案程式、全域settings或auth；只保存稽核文件。完整prompt／system／credentials不複製入報告。

## 建議下一步
1. 若要稽核smart-reports近期Subagent，請提供實際含該批派遣的session；指定的2026-09-09檔案無可核對案例。
2. 不因這次稽核重做已完成修復；startup原始根因仍屬既有未知事件。
3. 如需修正SA-AUDIT-002／003或reviewer委派契約，先另行授權定位／修復，保留status、trust、既有followUp與記錄不改写的邊界。
