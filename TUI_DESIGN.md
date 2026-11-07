# TUI自製計畫
## 主畫面
* 輸入框部分修改

 ```
 ▀▀█  v1.5.0
 █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 Press ctrl+o to show full startup help and loaded resources.

 Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.


[Context]
  ~\.pi\agent\AGENTS.md, AGENTS.md

[Skills]
  agents-md-creator, audit-plan, clean-code-refactor, create-plan, draft-plan, execute-plan,
expert-lens, find-skills, orca-cli, pi-tools-config, playwright-cli, reproduce-bug, research-plan,
review-diff, software-architecture-principles, software-refactory, software-reliability,
software-scan-bugs, test-case-creator, test-suite-tidy, thinking-plan, verify-findings,
write-prompt

[Prompts]
  /implement, /implement-and-review, /scout-and-plan

[Extensions]
  @lordekeen/pi-navigator, fff-override.mjs, file-audit/src, file-tools/src, fork/src,
gpt-speed/src, json-schema/src, monitor/src, note-tools/src, orca-agent-status.ts,
orca-prefill.ts, orca-titlebar-spinner.ts, pi-auto-compact/src, pi-runtime/src, pty-terminal/src,
remote/src, schedule-prompt/src, shell-tools/src, skill-tools/src, sql-connector/src,
sqlite-tools/src, subagents/src, theme-tools/src, web-tools/src


 Reloaded keybindings, extensions, skills, prompts, themes, and context files



──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000
```
---

## 背景任務面板

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 ⌘ Shell: 0 · ▷ Subagents: 0 · ⋔ Fork: 0 · ⌖ Monitor: 0
 🞟 <shell|subagent|fork|monitor info>
 🞟 <shell|subagent|fork|monitor info>
  ... 3 more [Open]
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## Subagent / Fork/ Subagent / Monitor 展開
* 點擊選項可以顯示串流內容
* 內容為串流

```
── Jobs Panel ────────────────────────────────────────────────────────────────────────────────────
 ▌ <Content...Max 8 lines , scrollable> 
 ▌
 ▌
 ▌
 ▌
 ▌
 ▌
 ▌
 ↑/↓ move  Enter/←/→ change  Tab page  Ctrl+S save  Esc close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## Settings面板
* 以/settings:web-tools為例

```
── Web Tools ────────────────────────────────────────────────────────────────────────────────────
 [ Search ]   Fetch
 -----------------------------------------------------------------------------------------------
 Search
 ▸ web_search enabled          [x]
    Provider                    ‹ brave ›
    Results                     5
    Search timeout (ms)         60000
 Brave
    Key source                  ‹ key ›
    API key                     ******** (configured; Enter to replace)

 ↑/↓ move  Enter/←/→ change  Tab page  Ctrl+S save  Esc close
 ❯  
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## 詢問問題(例如是否同意權限)

```
── Title ──────────────────────────────────────────────────────────────────────────────────────────

 Description
 
 [Yes] [No]

───────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000

```

---

## Tool Call
* 移除背景方塊
* 所有工具未展開都使用兩行 顯示最重要訊息
以write為例


收合範例
```

● write <FileName>
   1024 byte written...                                                         [Click to expend]

● $ cd /c/GitHub/pi-better-tools && grep -rn "visibleWidth" node_modules/@earen...(timeout 20s)
   Took 0.2s                                                                    [Click to expend]

──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000
```

展開範例

```

● $ cd /c/GitHub/pi-better-tools && grep -rn "visibleWidth"
   node_modules/@earendil-works/pi-tui/dist/*.js 2>/dev/null | head -5 (timeout 20s)

   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:3:import { getGraphemeSegmenter,
   ▌ stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.js";
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:55:                const width =
   ▌ visibleWidth(text);
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:243:        const inputWidth =
   ▌ Math.max(0, innerWidth - visibleWidth(resultText));
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:245:        const inputPadding =
   ▌ " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
   ▌ node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js:252:        let controlsWidth =
   ▌ visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);

   Took 0.2s                                                                   [Click to Collapse]

──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  C:\GitHub\pi-better-tools (mux-text)                        [▓▓▓▓░░░░░░░░] 0.0% 0k/272k (auto)
  opencode-go · deepseek-v4.1-flash ·  high                     Normal |   0 |   0 |  $0.000
```

---

## 其他
1. Thinking 預設為收合(目前預設為展開)