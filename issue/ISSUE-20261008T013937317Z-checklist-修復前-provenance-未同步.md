# Checklist 修復前 provenance 未同步

2026-10-08 初始 SHA-256 inventory 查出 51 個既有 provenance 不符；本次工作開始前已存在，不宣稱全部為本次改動。`npm run sources:verify` 初跑在 `modules/pty-terminal/src/matcher.ts` 失敗。

範圍：PTY 6 imported + matcher、Subagents index/protocol/session-store/subsession-log 與測試/README/concurrency/review-fixes、Shell timeout 描述/README/background-jobs 與測試、File debug-logging/file-operations/測試/README、Web extract/network/service/測試/README、Schedule README/scheduler/storage/widget 與 scheduler/stability 測試、Note implementation/tests/README、GPT implementation/tests、JSON Schema implementation/schema/extract/delivery/workers/tests，以及根 smoke/renderer fixture。

處理原則：由對應 worker 逐 ID 查證目前程式及回歸測試後，僅針對已審查的 local snapshot 更新 provenance；保留 immutable `docs/sources.json` 與 originalSha256，不宣稱歷史原始差異或 source-equivalence。根 fixtures 另交獨立 reviewer 審查。尚未完成審查前，不以批次重新雜湊掩蓋未知差異。