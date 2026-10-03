# macOS 安裝說明補充

## 變更

- README.md 新增 macOS（Apple Silicon／Intel）安裝章節，比照既有 Linux／WSL2 說明。
- 使用現有 browser:install，未新增 script 或更動依賴／產品程式码。
- 說明配套 Chromium、macOS 快取、使用者／架構／PLAYWRIGHT_BROWSERS_PATH 一致性、支援 OS 與錯誤排除；不要求 sudo 或安全保護繞過。
- 同步 docs/configuration.md 與 docs/adaptations.json。

## 驗證

- `npm run browser:install -- --dry-run` 成功，當前 Darwin ARM64 選用 mac-arm64 Chromium，快取位於 ~/Library/Caches/ms-playwright。
- `npm run test:browser` 成功，2/2 stages，13 個測試均通過、0 skipped；證據：plan/evidence/macos-docs-browser.log。
- docs/adaptations.json JSON 解析與 git diff --check 通過。
- 本輪僅文件變更，未重跑 build/typecheck/unit/integration/package 或 production matrix；前輪未解決事項仍見 ENVIRONMENT-CHECK-2026-10-03.md，不因文件補充宣稱修復。
- 未修改全域 Pi settings/auth，未呼叫真實 provider。
