# Footer 驗證遇到 Subagents runner I/O fixture 啟動期限失敗

2026-10-07。本次使用者需求是footer狀態摘要及背景log_ready不洗版，不修改runner lifecycle或I/O timeout契約。

## 證據

- 根unit：9/10 stages，Subagents251/253；close-stall/spool-read-stall在注入前耗盡begin managed run300ms。
- Subagents module：2/3 stages，unit251/253；header-abort/close-stall在注入前耗盡begin/allocate managed300ms。TypeScript及36 integration通過。
- cross結束後隔離原runner-io：17 tests，5 pass／12 fail，0 skip。失敗皆為fault injection未到達，fixture在begin/allocate managed階段提前settle；isolated也失敗，因此不能宣稱只由併發檢查造成或已解決。
- 原測試 `modules/subagents/tests/runner-io.test.ts:158–165` 對多數case使用300ms ioTimeoutMs，涵蓋真實filesystem setup；fixture用entered與result race正確揭露未到注入點，不是假通過。
- 記錄：`plan/evidence/footer-status-20261007T084402Z/initial-pipeline.log`、`runner-io-isolated.log`及unit/module初始JSON。

## 邊界與狀態

沒有放寬deadline或assertions、沒有skip失敗case、沒有為重跑改動runner/test-fixture。原因尚未確認，可能涉及本機I/O延遲，但沒有量測支持，不可稱環境問題已排除或产品無問題。先前歷史有相同fixture期限失敗，但不等於這次可算通過。

本次25 focused、Shell64unit/36integration、Subagents36integration、root typecheck9/9、cross3/3及provenance通過；不能替代失敗unit。追加pipeline因isolated失敗依契約exit1，後續complete Subagents module與第二次root unit未執行。

留待單獨調查fixture setup和filesystem latency；不在本次顯示修改中擅自放寬契約。
