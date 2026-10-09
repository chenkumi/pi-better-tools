# 主審穩定性審查進度：File／JSON／Note／GPT

本次主任務：`plan/PLAN-20261007T053926327Z-當前專案穩定性-code-review.md`。來源基準`plan/evidence/review-20261007T053926Z/source-baseline.json`，86 source檔、無Git。產品未修改。

## 目前已查

已完整閱讀四模組README、file-operations.ts（1518行）、diff-runner.ts、file-tools extension、JSON全部實作/schema/extract/delivery/extension、Note與GPT extensions；讀schema/delivery既有測試、offline JSON fixture、Pi1.0.0 print-mode生命周期和zod4.6.5實際converter關鍵段。

### BUG-001：JSON Schema enum/const 合併約束漏驗（Medium，已確認／已觀察）

`modules/json-schema/src/schema.ts:63-65,92,106-109`：audit把enum/const當可錨定type-specific constraints，但zod converter沒有套用所有兄弟約束。實際compile `properties.x={enum:['a','ab'],minLength:2}`與`{const:'a',minLength:2}`均未被reject；`.validate({x:'a'})`回undefined（錯誤接受）。完整触发可經JSON extension recover最後assistant text（129-131）直接交付，沒有宿主json_output參數validator反證。需保存schema+assertions並交叉證明明列type情況／真正extension delivery（fake ctx、隔離檔案）。預期是startup拒絕無法忠實的組合或驗證失敗，不是接受無效資料。

### BUG-002：JSON Schema pattern 同步驗證缺少可中斷預算（Medium，已確認／已觀察）

`schema.ts:106-107`同步safeParse；鎖定zod converter `node_modules/zod/src/v4/classic/from-json-schema.ts:575-577`以new RegExp直接執行。使用者schema含nested quantifier，模型text近似匹配可能造成長時間event-loop阻塞；extract fallback60秒AbortSignal不能中斷同步validator。計畫獨立child、初始化ready後最多1秒運算窗、強制終止owned child並等待close，對安全pattern作控制組；不在主Pi行程跑hazard、不新增產品tests。需要記録runtime的V8 regex fallback flags與已知取捨，避免以CPU候選冒稱實際TUI已掛死。

### 已排除／限制

- tuple additionalItems內not雖audit未遞迴，鎖定zod本身在startup拒絕，未觀察silent bypass，不列缺陷。
- File edit literal/regex/diff都在commit前validation；snapshot再驗＋公開file mutation queue、worker abort/deadline/close guard已存在，不把任意外部writer TOCTOU（README明示）當新增原子性bug。
- Note symlink目錄驗證與wx、寫入失敗刪partial已存在；TOCTOU外部攻擊非本次穩定性已確認問題。
- GPT synchronous短critical section/proper-lockfile+readmerge+原子rename、不能取得lock會warn，不觀察unlocked write；provider/model pattern信賴與既有project override是明示行為，不以模型是否真的支援速度層級做線上推薦。
- JSON shutdown移除signal listener過早疑點需核對實際CLI：print-mode在正常dispose前也移除signalhandlers，真OSsignal預設可能直接退出；目前不足以證明『取消後仍交付』，不列已確認缺陷。只用process.emit不能證明真SIGTERM語意。

## 隔離結果（2026-10-07 UTC）

- BUG-001：`plan/evidence/review-20261007T053926Z/json-schema-constraints.mjs`與`.log`：enum/const缺type及enum明列type均接受不符合minLength的`a`；plain type控制組拒絕。實際extension message_end→recover→shutdown寫出`{x:'a'}`，getActiveTools空、沒有provider請求，獨立temp已移除。既有schema測試僅各別enum/bounds，不覆蓋交集。
- BUG-002：`json-schema-regex-child.mjs`、`json-schema-regex-probe.mjs`與`.log`：Node26.8.1/無NODE_OPTIONS，安全`^a+$`控制組0.8ms返回；`(a+)+$`與`a*32+'!'`在validator ready後1000ms未返回，由外部watchdog SIGKILL（不是產品防護）終止，close已觀察，沒有殘留child。只證明>1秒及同步不可中斷，沒有宣稱無限等待或量測完整最壞時間。因structured output是print-only、schema需使用者選用，評Medium而非全產品High。建議可終止worker或等效安全pattern策略，不以同一event-loop的AbortSignal冒充interrupt。

## 下一步

整合三位子審並做候選的來源核對／最小重播。前一任務整套測試不是本次review新證據。BUG-001/002均不修改產品；stdout/FIFO或實際OS訊號等沒有驗證的風險不得推成已確認。

