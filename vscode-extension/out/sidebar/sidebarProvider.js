"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
class SidebarProvider {
    extensionUri;
    router;
    arena;
    agentLoop;
    diffManager;
    terminalWatcher;
    static viewType = 'aidot.sidebar';
    view;
    constructor(extensionUri, router, arena, agentLoop, diffManager, terminalWatcher) {
        this.extensionUri = extensionUri;
        this.router = router;
        this.arena = arena;
        this.agentLoop = agentLoop;
        this.diffManager = diffManager;
        this.terminalWatcher = terminalWatcher;
        // Listen for arena result updates
        this.arena.onResultsUpdate((results, isComplete) => {
            this.view?.webview.postMessage({
                type: 'ARENA_RESULTS',
                results,
                isComplete
            });
        });
        // Listen for agent loop step logging
        this.agentLoop.setStepCallback((step) => {
            this.view?.webview.postMessage({
                type: 'LOG_STEP',
                step
            });
        });
    }
    resolveWebviewView(webviewView, context, _token) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'SEND_PROMPT': {
                    await this.handleUserPrompt(data.prompt, data.mode, data.preferredProvider);
                    break;
                }
                case 'FIX_TERMINAL': {
                    await this.handleTerminalAutoFix();
                    break;
                }
                case 'ACCEPT_DIFF': {
                    await this.diffManager.acceptDiff();
                    this.view?.webview.postMessage({ type: 'DIFF_CLEARED' });
                    break;
                }
                case 'REJECT_DIFF': {
                    await this.diffManager.rejectDiff();
                    this.view?.webview.postMessage({ type: 'DIFF_CLEARED' });
                    break;
                }
                case 'PREVIEW_ARENA_DIFF': {
                    const editor = vscode.window.activeTextEditor;
                    if (editor && data.code) {
                        await this.diffManager.previewDiff(editor.document, data.code);
                        this.view?.webview.postMessage({ type: 'DIFF_READY' });
                    }
                    break;
                }
                case 'GET_STATUS': {
                    this.syncStatus();
                    break;
                }
            }
        });
        this.syncStatus();
    }
    syncStatus() {
        if (!this.view)
            return;
        const connected = this.router.getConnectedProviders();
        const available = this.router.getAvailableProviders();
        this.view.webview.postMessage({
            type: 'STATUS_UPDATE',
            connected,
            available,
            hasPendingDiff: this.diffManager.hasPendingDiff()
        });
    }
    async handleUserPrompt(promptText, mode, preferredProvider) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Please open a code file in VS Code first!');
            return;
        }
        const doc = editor.document;
        const fileContent = doc.getText();
        const fileName = doc.fileName.split(/[\\/]/).pop() || 'file';
        const fullPrompt = this.agentLoop.buildSystemPrompt(promptText, fileContent, fileName);
        if (mode === 'arena') {
            const connected = this.router.getConnectedProviders();
            if (connected.length === 0) {
                vscode.window.showErrorMessage('No browser tabs connected! Open ChatGPT, Claude, Gemini, or DeepSeek.');
                return;
            }
            this.arena.broadcastToAll(connected, fullPrompt);
            this.view?.webview.postMessage({
                type: 'LOG_STEP',
                step: `⚔️ Arena Mode: Broadcast prompt to ${connected.join(', ')}...`
            });
        }
        else {
            // Auto-Failover or Pinned
            const routeResult = this.router.routePrompt(fullPrompt, promptText, mode === 'auto' ? undefined : preferredProvider);
            if (!routeResult) {
                vscode.window.showErrorMessage('No available AI tabs! Ensure Chrome companion is active.');
            }
            else {
                this.view?.webview.postMessage({
                    type: 'LOG_STEP',
                    step: `🚀 Routing prompt to ${routeResult.provider}...`
                });
            }
        }
    }
    async handleTerminalAutoFix() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Please open the code file associated with the terminal error.');
            return;
        }
        const errorSnippet = await this.terminalWatcher.promptForTerminalFix();
        if (!errorSnippet)
            return;
        const doc = editor.document;
        const fileContent = doc.getText();
        const fileName = doc.fileName.split(/[\\/]/).pop() || 'file';
        const promptText = `Terminal build/test error encountered:
\`\`\`
${errorSnippet}
\`\`\`
Please analyze the error and patch the active file to resolve it.`;
        const fullPrompt = this.agentLoop.buildSystemPrompt(promptText, fileContent, fileName);
        const routeResult = this.router.routePrompt(fullPrompt, promptText);
        if (routeResult) {
            this.view?.webview.postMessage({
                type: 'LOG_STEP',
                step: `🔧 Auto-Fix: Sending error context to ${routeResult.provider}...`
            });
        }
    }
    getHtmlForWebview(webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>aiDot Web AI</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --accent: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --border: var(--vscode-input-border, #3c3c3c);
      --badge-bg: var(--vscode-badge-background, #007acc);
      --badge-fg: var(--vscode-badge-foreground, #fff);
      --card-bg: var(--vscode-editorWidget-background, #252526);
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background-color: var(--bg);
      margin: 0;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 11px;
    }
    .control-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    label {
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.8;
      font-weight: 600;
    }
    select, textarea, button {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--border);
      padding: 8px;
      border-radius: 4px;
      font-family: inherit;
      box-sizing: border-box;
      width: 100%;
    }
    select:focus, textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    button.primary {
      background: var(--accent);
      color: var(--vscode-button-foreground);
      font-weight: 600;
      cursor: pointer;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    button.primary:hover {
      background: var(--accent-hover);
    }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      cursor: pointer;
    }
    .button-row {
      display: flex;
      gap: 6px;
    }
    .tabs-indicator {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .tab-tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #333;
    }
    .tab-tag.online {
      background: #1b5e20;
      color: #a5d6a7;
    }
    .tab-tag.offline {
      background: #3e2723;
      color: #ffccbc;
    }
    .diff-banner {
      background: #0d47a1;
      color: #e3f2fd;
      padding: 8px;
      border-radius: 4px;
      display: none;
      flex-direction: column;
      gap: 6px;
    }
    .arena-section {
      display: none;
      flex-direction: column;
      gap: 8px;
      border-top: 1px solid var(--border);
      padding-top: 8px;
    }
    .arena-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .arena-header {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
    }
    .log-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px;
      font-size: 11px;
      max-height: 120px;
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family, monospace);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">⚡ aiDot Web AI</div>
    <div id="statusBadge" class="badge">Checking tabs...</div>
  </div>

  <div class="control-group">
    <label>Connected Free Web Chats</label>
    <div id="tabsIndicator" class="tabs-indicator">
      <span class="tab-tag offline">Claude (offline)</span>
      <span class="tab-tag offline">ChatGPT (offline)</span>
      <span class="tab-tag offline">Gemini (offline)</span>
      <span class="tab-tag offline">DeepSeek (offline)</span>
    </div>
  </div>

  <div class="control-group">
    <label>Execution Mode & Provider</label>
    <select id="modeSelect">
      <option value="auto">⚡ Auto-Free-Tier Rotator (Claude → ChatGPT → Gemini → DeepSeek)</option>
      <option value="arena">⚔️ Arena Mode (Ask All Connected AI Concurrently)</option>
      <option value="Claude">Claude Web Only</option>
      <option value="ChatGPT">ChatGPT Web Only</option>
      <option value="Gemini">Gemini Web Only</option>
      <option value="DeepSeek">DeepSeek Web Only</option>
    </select>
  </div>

  <div class="control-group">
    <label>Instruction</label>
    <textarea id="promptInput" placeholder="What should the AI change or build in this file?"></textarea>
  </div>

  <button id="sendBtn" class="primary">🚀 Send & Preview Diff</button>
  <button id="terminalBtn" class="secondary">🔧 Fix Terminal Error</button>

  <div id="diffBanner" class="diff-banner">
    <div><b>Diff Ready for Review:</b> Inspect changes in editor tabs.</div>
    <div class="button-row">
      <button id="acceptDiffBtn" class="primary" style="flex:1;">Accept</button>
      <button id="rejectDiffBtn" class="secondary" style="flex:1;">Reject</button>
    </div>
  </div>

  <div id="arenaSection" class="arena-section">
    <label>⚔️ Arena Mode Responses</label>
    <div id="arenaCards"></div>
  </div>

  <div class="control-group">
    <label>Live Agent Status</label>
    <div id="logBox" class="log-container">Waiting for instructions...</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const sendBtn = document.getElementById('sendBtn');
    const terminalBtn = document.getElementById('terminalBtn');
    const promptInput = document.getElementById('promptInput');
    const modeSelect = document.getElementById('modeSelect');
    const tabsIndicator = document.getElementById('tabsIndicator');
    const statusBadge = document.getElementById('statusBadge');
    const logBox = document.getElementById('logBox');
    const diffBanner = document.getElementById('diffBanner');
    const acceptDiffBtn = document.getElementById('acceptDiffBtn');
    const rejectDiffBtn = document.getElementById('rejectDiffBtn');
    const arenaSection = document.getElementById('arenaSection');
    const arenaCards = document.getElementById('arenaCards');

    const ALL_PROVIDERS = ['Claude', 'ChatGPT', 'Gemini', 'DeepSeek'];

    sendBtn.addEventListener('click', () => {
      const prompt = promptInput.value.trim();
      if (!prompt) return;
      const mode = modeSelect.value;
      const isPinned = !['auto', 'arena'].includes(mode);

      vscode.postMessage({
        type: 'SEND_PROMPT',
        prompt,
        mode: isPinned ? 'pinned' : mode,
        preferredProvider: isPinned ? mode : undefined
      });
      promptInput.value = '';
    });

    terminalBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'FIX_TERMINAL' });
    });

    acceptDiffBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'ACCEPT_DIFF' });
    });

    rejectDiffBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'REJECT_DIFF' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'STATUS_UPDATE') {
        renderTabs(msg.connected || []);
        if (msg.hasPendingDiff) {
          diffBanner.style.display = 'flex';
        }
      }

      if (msg.type === 'LOG_STEP') {
        const p = document.createElement('div');
        p.textContent = msg.step;
        logBox.appendChild(p);
        logBox.scrollTop = logBox.scrollHeight;
      }

      if (msg.type === 'DIFF_READY') {
        diffBanner.style.display = 'flex';
      }

      if (msg.type === 'DIFF_CLEARED') {
        diffBanner.style.display = 'none';
      }

      if (msg.type === 'ARENA_RESULTS') {
        renderArena(msg.results || [], msg.isComplete);
      }
    });

    function renderTabs(connectedList) {
      tabsIndicator.innerHTML = '';
      ALL_PROVIDERS.forEach(provider => {
        const isOnline = connectedList.includes(provider);
        const tag = document.createElement('span');
        tag.className = 'tab-tag ' + (isOnline ? 'online' : 'offline');
        tag.textContent = provider + (isOnline ? ' (online)' : ' (offline)');
        tabsIndicator.appendChild(tag);
      });
      statusBadge.textContent = connectedList.length > 0 ? connectedList.length + ' online' : 'No tabs';
    }

    function renderArena(results, isComplete) {
      arenaSection.style.display = 'flex';
      arenaCards.innerHTML = '';
      results.forEach(res => {
        const card = document.createElement('div');
        card.className = 'arena-card';
        card.innerHTML = \`
          <div class="arena-header">
            <span>\${res.provider}</span>
            <span style="font-size:10px; opacity:0.8;">Ready</span>
          </div>
          <button class="secondary" style="font-size:11px;" onclick="previewArenaDiff('\${res.provider}')">
            Preview \${res.provider} Diff
          </button>
        \`;
        arenaCards.appendChild(card);
      });
      window.arenaResultsCache = results;
    }

    window.previewArenaDiff = function(provider) {
      const match = (window.arenaResultsCache || []).find(r => r.provider === provider);
      if (match) {
        vscode.postMessage({
          type: 'PREVIEW_ARENA_DIFF',
          code: match.code,
          provider
        });
      }
    };

    // Ask for initial status
    vscode.postMessage({ type: 'GET_STATUS' });
  </script>
</body>
</html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
//# sourceMappingURL=sidebarProvider.js.map