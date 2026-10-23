---
name: clean-code-refactor
description: Use when the user asks to clean up, tidy, or refactor existing code by clean code principles (整理程式碼、clean code、重構、消除重複、拆長函式) while keeping behavior unchanged, including multi-module or parallel-agent cleanups.
---

# Clean Code Refactor

依 clean code 原則整理既有程式碼：讓下一個讀的人能快速看懂、放心修改。整理是**行為不變**的工作；缺陷修正與行為變更另外處理。使用者的即時指示優先於本技能內容。

## 完成條件與何時停下

完成指：本輪範圍內的修改都通過與修改前相同基準的檢查；diff 沒有未授權的行為變更、風格雜訊或驗證降級；交付說明列出實際驗證、未執行項目與剩餘風險。判準是認知負擔下降（重複的知識只剩一份、函式各做一件事、名稱說明意圖），行數只是附帶結果。

- 只要求分析時，交付候選與證據後停止，不改程式。
- 範圍不明（整個 repo？哪些模組？含第三方／vendored 程式碼嗎？）先問一次；其他取捨合理推斷並繼續。
- 必要性不明的程式碼保留，列為待決項。

## 流程

1. **界定範圍。** 讀專案規則（AGENTS.md／CLAUDE.md／README）與目標模組文件。排除第三方、vendored、生成碼，除非使用者明確納入。記下不可改的契約：工具／API 名稱、schema、設定鍵、儲存路徑、持久格式、錯誤碼與訊息、權限與安全語意、時序與取消行為。
2. **建立基準。** 動手前執行目標模組的測試、型別檢查與 lint，記錄通過／失敗／skip／todo 數與既有的預期失敗。之後只和這份基準比較。
3. **找候選。** 依 [references/principles.md](references/principles.md) 判斷：重複的知識、做太多事的長函式、魔術數字、誤導的名稱、可證明的死碼。每個模組挑少數高價值、明確正確的修改，不追求數量。
4. **小批修改。** 一次一種整理、一個模組；改完立刻跑該模組檢查。用精確字串替換的編輯工具改檔，不用 shell 管線或多層引號的腳本改寫原始碼（見 principles「工具陷阱」）。
5. **自我審查等價性。** 逐項對照 [references/review-checklist.md](references/review-checklist.md)：檢查順序、錯誤文字、對外字串逐字相同、被刪的檢查確實不可達、跨模組 export 未變。
6. **整理中發現缺陷時分開處理。** 不混進整理的 diff。回報給使用者；獲准修正時先寫回歸測試並在修改前的程式上確認 red，再修正確認 green。
7. **同步專案中繼資料。** 專案若記錄檔案雜湊、provenance、changelog 或文件中的行為描述，依其既有格式更新（保留手寫格式，改完重新解析驗證），並執行其驗證命令。新增或首次觸及、但未登錄的檔案補登錄。
8. **最終全量重跑。** 所有修改就位後，依序重跑全部受影響模組（含引用它們的模組）與根層級檢查，確認與基準一致。

## 平行整理（多模組時）

模組彼此獨立時可交給子代理平行處理。簡報與審查方式見 [references/review-checklist.md](references/review-checklist.md)「委派」。要點：每個子代理只改自己的模組、不碰共用的中繼資料檔；協調者逐一審查 diff，不採信回報本身；中繼資料由協調者統一寫入；子代理各自的測試是在別人修改進行中跑的，最後必須在完整狀態下重跑。

## 交付

格式依 [references/report.md](references/report.md)。
