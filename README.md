# aiDot: Web AI Agent & Multi-Model Bridge for VS Code

**aiDot** connects free browser-based AI chats (**Claude, ChatGPT, Gemini, DeepSeek**) directly into VS Code as a full agentic coding assistant with surgical SEARCH/REPLACE diff preview, automatic free-tier failover, and multi-model Arena Mode.

---

## 🌟 Key Features

1. **Auto-Free-Tier Rotator & Failover**:
   - Run prompts against **Claude $\to$ ChatGPT $\to$ Gemini $\to$ DeepSeek**.
   - If one service hits a message cap or rate limit banner, aiDot detects it in the browser DOM and automatically routes the prompt to the next available tab without interrupting your flow.

2. **⚔️ Arena Mode (Ask All Connected AI)**:
   - Broadcast a single prompt to **all connected browser tabs concurrently**.
   - Review responses in side-by-side cards in the VS Code sidebar and preview each diff before choosing which one to apply.

3. **Interactive Side-by-Side Diff Preview**:
   - Never blindly overwrite files.
   - Parses `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` blocks and opens VS Code's native red/green diff viewer with **Accept** and **Reject** buttons.

4. **Terminal Error Auto-Fix**:
   - One-click button in the sidebar to capture build/test errors from the terminal, bundle it with the active file context, and prompt the AI for an immediate patch.

5. **Agentic Tool Loop**:
   - The AI can inspect file paths (`<read_file>`), inspect directory trees (`<list_dir>`), and run verified terminal commands (`<run_command>`) with user approval.

6. **Dynamic Selector Sync (`selectors.json`)**:
   - Website DOM classes change over time. aiDot loads selectors dynamically from `selectors.json` inside the VS Code extension and synchronizes them to the Chrome extension on connection—no need to reload or rebuild the Chrome extension.

---

## 🚀 Quick Start Guide

### Step 1: Install & Compile the VS Code Extension
1. Open this repository in VS Code:
   ```bash
   cd /Users/varunmathiyalagan/Desktop/projects/aiDot/vscode-extension
   npm install
   npm run compile
   ```
2. Press **F5** in VS Code to launch the **[Extension Development Host]** window with aiDot running.
3. The WebSocket server automatically starts listening on `ws://localhost:8765`.

### Step 2: Load the Chrome Extension Companion
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** (top right switch).
3. Click **Load unpacked** and select the folder:
   `/Users/varunmathiyalagan/Desktop/projects/aiDot/chrome-extension`
4. The aiDot companion background worker will immediately connect to your local VS Code extension.

### Step 3: Open Your Free Web Chats
Open any or all of the supported AI web chats in Chrome tabs:
- [Claude](https://claude.ai)
- [ChatGPT](https://chatgpt.com)
- [Gemini](https://gemini.google.com)
- [DeepSeek](https://chat.deepseek.com)

In your VS Code Activity Bar, click the **aiDot** sparkle icon. You will see your open tabs turn **online** in real time!

---

## 🛠️ Usage Workflows

### 1. Code Editing with Auto-Failover
- Open any source code file in VS Code.
- In the aiDot sidebar, choose **⚡ Auto-Free-Tier Rotator**.
- Enter your instructions (e.g., *"Refactor this function to handle edge cases and add TypeScript types"*).
- Click **🚀 Send & Preview Diff**.
- Inspect the green/red changes in the native diff editor. Click **Accept** or **Reject** in the sidebar.

### 2. Arena Mode (Ask All Connected AI)
- In the sidebar dropdown, select **⚔️ Arena Mode**.
- Enter your prompt and click Send.
- The prompt is dispatched to Claude, ChatGPT, Gemini, and DeepSeek in parallel.
- Once completed, preview each model's proposed diff card in the sidebar and apply your favorite!

### 3. Fixing Terminal Errors
- If a terminal command or build fails, click **🔧 Fix Terminal Error** in the sidebar.
- aiDot captures the error stack trace and automatically asks the active AI to fix it in your file.
