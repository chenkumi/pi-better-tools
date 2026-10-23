---
name: clean-code-refactor
description: Use when the user asks to tidy or refactor existing code by clean code principles (unify duplicated knowledge, split long functions, name magic values, fix misleading names) while keeping behavior unchanged, including multi-module cleanups delegated to parallel subagents.
---

# Clean Code Refactor

依 clean code 原則整理既有程式碼：讓下一個讀的人能快速看懂、放心修改。整理是**行為不變**的工作；缺陷修正與行為變更另外處理。只想刪除多餘程式或降低複雜度、不需要原則層級的整理時，`software-refactory` 也適用。使用者的即時指示優先於本技能內容。

## 完成條件與何時停下

完成指：本輪範圍內的修改都通過與修改前相同基準的檢查；diff 沒有未授權的行為變更、風格雜訊或驗證降級；交付說明列出實際驗證、未執行項目與剩餘風險。判準是認知負擔下降（重複的知識只剩一份、函式各做一件事、名稱說明意圖），行數只是附帶結果。

- 只要求分析時，交付候選與證據後停止，不改程式。
- 範圍不明（整個 repo？哪些模組？含第三方／vendored 程式碼嗎？）先問一次；其他取捨合理推斷並繼續。
- 必要性不明的程式碼保留，列為待決項。

## 流程

1. **界定範圍。** 讀專案規則（AGENTS.md 等）與目標模組文件。排除第三方、vendored、生成碼，除非使用者明確納入。記下不可改的契約：工具／API 名稱、schema、設定鍵、儲存路徑、持久格式、錯誤碼與訊息、權限與安全語意、時序與取消行為。
2. **建立基準。** 動手前執行目標模組的測試、型別檢查與 lint，記錄通過／失敗／skip／todo 數與既有的預期失敗。之後只和這份基準比較。執行很久的檢查放到 Shell 背景 job，等完成通知，不輪詢。
3. **找候選。** 依 [references/principles.md](references/principles.md) 判斷：重複的知識、做太多事的長函式、魔術數字、誤導的名稱、可證明的死碼。每個模組挑少數高價值、明確正確的修改，不追求數量。
4. **小批修改。** 一次一種整理、一個模組；改完立刻跑該模組檢查。原始碼一律用 `edit`／`write` 修改，不經由 shell 重新導向、`sed` 或一次性腳本改寫（見 principles「工具陷阱」）。
5. **自我審查等價性。** 逐項對照 [references/review-checklist.md](references/review-checklist.md)：檢查順序、錯誤文字、對外字串逐字相同、被刪的檢查確實不可達、跨模組 export 未變。
6. **整理中發現缺陷時分開處理。** 不混進整理的 diff。回報給使用者；獲准修正時先寫回歸測試並在修改前的程式上確認 red，再修正確認 green。
7. **同步專案中繼資料。** 專案若記錄檔案雜湊、provenance、changelog 或文件中的行為描述，依其既有格式更新（保留手寫格式，改完重新解析驗證），並執行其驗證命令。被修改但從未登錄的檔案補登錄。
8. **最終全量重跑。** 所有修改就位後，依序重跑全部受影響模組（含引用它們的模組）與根層級檢查，確認與基準一致。

長程或分批的工作，把範圍、基準、每批結果與剩餘風險記在任務紀錄；有 `note` 工具時用它建立 plan／report。

## 平行整理（多模組時）

模組彼此獨立時，可用 `subagent` 平行處理，遵守宿主的子代理上限，超過時分批。簡報與審查方式見 [references/review-checklist.md](references/review-checklist.md)「委派」。要點：每個子代理只改自己的模組、不碰共用的中繼資料檔；子代理的輸出是待驗證的主張，協調者逐一閱讀 diff 審查；中繼資料由協調者統一寫入；子代理各自的測試是在其他人修改進行中跑的，全部完成後必須在完整狀態下重跑。

## 交付

格式依 [references/report.md](references/report.md)。
