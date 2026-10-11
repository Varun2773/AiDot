import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MultiProviderRouter } from '../orchestrator/router';
import { ArenaOrchestrator, ArenaResult } from '../orchestrator/arena';
import { AgentLoop } from '../orchestrator/agentLoop';
import { DiffManager } from '../diff/diffManager';
import { TerminalWatcher } from '../terminal/terminalWatcher';
import { ProviderName } from '../server/protocol';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  provider?: ProviderName | 'Arena';
  text: string;
  code?: string;
  hasDiff?: boolean;
  timestamp: number;
  arenaResults?: ArenaResult[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aidot.sidebar';
  private view?: vscode.WebviewView;

  // Session-wise chat history state
  private sessions: ChatSession[] = [];
  private activeSessionId: string = '';

  // In-flight & UI state persistence
  private draftPrompt: string = '';
  private isWaitingForResponse: boolean = false;
  private currentWaitingTarget: string = 'AI';
  private currentArenaResults: ArenaResult[] | null = null;
  private isArenaInProgress: boolean = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly router: MultiProviderRouter,
    private readonly arena: ArenaOrchestrator,
    private readonly agentLoop: AgentLoop,
    private readonly diffManager: DiffManager,
    private readonly terminalWatcher: TerminalWatcher,
    private readonly globalState: vscode.Memento
  ) {
    // Restore persistent sessions
    const savedSessions = this.globalState.get<ChatSession[]>('aidot_chat_sessions');
    if (savedSessions && savedSessions.length > 0) {
      this.sessions = savedSessions;
      this.activeSessionId = this.globalState.get<string>('aidot_active_session_id') || this.sessions[0].id;
    } else {
      this.createNewSession();
    }

    // Listen for arena results
    this.arena.onResultsUpdate((results: ArenaResult[], isComplete: boolean) => {
      this.currentArenaResults = results;
      this.isArenaInProgress = !isComplete;
      if (isComplete) {
        this.isWaitingForResponse = false;
      }

      this.view?.webview.postMessage({
        type: 'ARENA_RESULTS',
        results,
        isComplete
      });

      // If arena is complete, persist results into the session so they never vanish!
      if (isComplete && results.length > 0) {
        const session = this.getActiveSession();
        if (session) {
          const combinedArenaText = results.map(r => `### ${r.provider}\n${r.rawText || r.code}`).join('\n\n---\n\n');
          session.messages.push({
            id: `arena_${Date.now()}`,
            sender: 'assistant',
            provider: 'Arena' as any,
            text: combinedArenaText,
            arenaResults: results,
            timestamp: Date.now()
          });
          session.updatedAt = Date.now();
          this.persistSessions();
          this.syncSessions();
        }
      }
    });

    // Listen for agent loop step logging
    this.agentLoop.setStepCallback((step: string) => {
      this.view?.webview.postMessage({
        type: 'LOG_STEP',
        step
      });
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    // CRITICAL: Retain context when user switches tabs or views another file in VS Code!
    // This keeps the DOM, chat scroll, and inputs alive exactly where you left them.
    (webviewView as any).retainContextWhenHidden = true;

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'SEND_PROMPT': {
          await this.handleUserPrompt(data.prompt, data.mode, data.preferredProvider, data.extraContext);
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
          let targetDoc: vscode.TextDocument | null = null;
          const targetUri = this.diffManager.getTargetFileUri();
          if (targetUri) {
            try {
              targetDoc = await vscode.workspace.openTextDocument(targetUri);
            } catch (e) {
              console.warn('[AiDot] Could not open target file URI:', e);
            }
          }
          if (!targetDoc) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.uri.scheme === 'file') {
              targetDoc = editor.document;
            }
          }
          if (targetDoc && data.code) {
            await this.diffManager.previewDiff(targetDoc, data.code);
            this.view?.webview.postMessage({ type: 'DIFF_READY' });
          }
          break;
        }

        case 'DRAFT_UPDATE': {
          this.draftPrompt = data.draft || '';
          break;
        }

        case 'NEW_SESSION': {
          this.draftPrompt = '';
          this.isWaitingForResponse = false;
          this.currentArenaResults = null;
          this.isArenaInProgress = false;
          this.createNewSession();
          this.syncSessions();
          this.restoreWebviewState();
          break;
        }

        case 'SWITCH_SESSION': {
          if (data.sessionId) {
            this.activeSessionId = data.sessionId;
            this.currentArenaResults = null;
            this.isArenaInProgress = false;
            this.isWaitingForResponse = false;
            this.persistSessions();
            this.syncSessions();
            this.restoreWebviewState();
          }
          break;
        }

        case 'DELETE_SESSION': {
          this.sessions = this.sessions.filter(s => s.id !== data.sessionId);
          if (this.sessions.length === 0) {
            this.createNewSession();
          } else if (this.activeSessionId === data.sessionId) {
            this.activeSessionId = this.sessions[0].id;
          }
          this.persistSessions();
          this.syncSessions();
          break;
        }

        case 'GET_STATUS': {
          this.syncStatus();
          this.syncSessions();
          this.syncActiveFileContext();
          this.restoreWebviewState();
          break;
        }

        case 'GET_WORKSPACE_FILES': {
          await this.sendWorkspaceFilesList(data.query || '');
          break;
        }
      }
    });

    this.syncStatus();
    this.syncSessions();
    this.syncActiveFileContext();
    this.restoreWebviewState();
  }

  public restoreWebviewState() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'RESTORE_STATE',
      draftPrompt: this.draftPrompt,
      isWaiting: this.isWaitingForResponse,
      waitingTarget: this.currentWaitingTarget,
      arenaResults: this.currentArenaResults,
      isArenaComplete: !this.isArenaInProgress,
      isArenaActive: this.isArenaInProgress
    });
  }

  public syncStatus() {
    if (!this.view) return;
    const connected = this.router.getConnectedProviders();
    const available = this.router.getAvailableProviders();
    this.view.webview.postMessage({
      type: 'STATUS_UPDATE',
      connected,
      available,
      hasPendingDiff: this.diffManager.hasPendingDiff()
    });
  }

  public syncActiveFileContext() {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor;
    const activeFileName = editor ? editor.document.fileName.split(/[\\/]/).pop() : null;
    this.view.webview.postMessage({
      type: 'ACTIVE_FILE_UPDATE',
      fileName: activeFileName
    });
  }

  private createNewSession() {
    const session: ChatSession = {
      id: `session_${Date.now()}`,
      title: 'New Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.persistSessions();
  }

  private persistSessions() {
    this.globalState.update('aidot_chat_sessions', this.sessions);
    this.globalState.update('aidot_active_session_id', this.activeSessionId);
  }

  private syncSessions() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'SESSIONS_UPDATE',
      sessions: this.sessions.map(s => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      })),
      activeSessionId: this.activeSessionId,
      activeMessages: this.getActiveSession()?.messages || []
    });
  }

  private getActiveSession(): ChatSession | undefined {
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  public handleIncomingAIResponse(provider: ProviderName, fullText: string, code: string, hasDiff: boolean) {
    this.isWaitingForResponse = false;
    const session = this.getActiveSession();
    if (session) {
      session.messages.push({
        id: `msg_${Date.now()}`,
        sender: 'assistant',
        provider,
        text: fullText || code,
        code,
        hasDiff,
        timestamp: Date.now()
      });
      session.updatedAt = Date.now();
      this.persistSessions();
      this.syncSessions();
    }
  }

  private async sendWorkspaceFilesList(query: string) {
    if (!this.view) return;
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 25);
    const fileList = files.map(f => {
      const rel = vscode.workspace.asRelativePath(f);
      return {
        path: rel,
        name: path.basename(rel)
      };
    }).filter(f => !query || f.path.toLowerCase().includes(query.toLowerCase()));

    this.view.webview.postMessage({
      type: 'WORKSPACE_FILES_RESULT',
      files: fileList
    });
  }

  private async handleUserPrompt(
    promptText: string,
    mode: string,
    preferredProvider?: ProviderName,
    extraContext?: string
  ) {
    const editor = vscode.window.activeTextEditor;
    let targetDocUri: vscode.Uri | null = (editor && editor.document.uri.scheme === 'file') ? editor.document.uri : null;
    const doc = editor ? editor.document : null;
    let fileContent = doc ? doc.getText() : '';
    let fileName = doc ? doc.fileName.split(/[\\/]/).pop() || 'file' : '';

    // Clear draft on submission
    this.draftPrompt = '';
    this.isWaitingForResponse = true;
    const isPinned = !['auto', 'arena'].includes(mode);
    this.currentWaitingTarget = isPinned ? (preferredProvider || mode) : (mode === 'arena' ? 'All AI tabs' : 'AI');

    // Automatically resolve any @file mentions in promptText
    const mentionRegex = /@([^\s]+)/g;
    let match: RegExpExecArray | null;
    let referencedFilesContext = extraContext || '';
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    while ((match = mentionRegex.exec(promptText)) !== null) {
      const relPath = match[1];
      const targetPath = path.isAbsolute(relPath) ? relPath : path.resolve(rootPath, relPath);
      if (fs.existsSync(targetPath)) {
        targetDocUri = vscode.Uri.file(targetPath);
        try {
          // If the file is open in an editor buffer, use its latest live text
          const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === targetPath);
          const content = openDoc ? openDoc.getText() : fs.readFileSync(targetPath, 'utf-8');
          referencedFilesContext += `\nReferenced File (${relPath}):\n\`\`\`\n${content}\n\`\`\`\n`;
          // If no active file open, use this mentioned file as active
          if (!fileContent) {
            fileContent = content;
            fileName = path.basename(relPath);
          }
        } catch (e) {
          console.warn('Could not read referenced file:', relPath);
        }
      }
    }

    if (targetDocUri) {
      this.diffManager.setTargetFileUri(targetDocUri);
    }

    // Append user message to active session history
    const session = this.getActiveSession();
    if (session) {
      if (session.messages.length === 0) {
        session.title = promptText.slice(0, 32).trim() || 'Conversation';
      }
      session.messages.push({
        id: `msg_${Date.now()}`,
        sender: 'user',
        text: promptText,
        timestamp: Date.now()
      });
      session.updatedAt = Date.now();
      this.persistSessions();
      this.syncSessions();
    }

    const fullPrompt = this.agentLoop.buildSystemPrompt(promptText, fileContent, fileName, referencedFilesContext);

    if (mode === 'arena') {
      this.isArenaInProgress = true;
      this.currentArenaResults = [];
      const connected = this.router.getConnectedProviders();
      if (connected.length === 0) {
        this.isWaitingForResponse = false;
        this.isArenaInProgress = false;
        vscode.window.showErrorMessage('No browser tabs connected! Open ChatGPT, Claude, Gemini, or DeepSeek.');
        return;
      }
      this.arena.broadcastToAll(connected, fullPrompt);
      this.view?.webview.postMessage({
        type: 'LOG_STEP',
        step: `⚔️ Arena Mode: Dispatched to ${connected.join(', ')}...`
      });
    } else {
      this.isArenaInProgress = false;
      this.currentArenaResults = null;
      const routeResult = this.router.routePrompt(
        fullPrompt,
        promptText,
        mode === 'auto' ? undefined : preferredProvider
      );

      if (!routeResult) {
        this.isWaitingForResponse = false;
        vscode.window.showErrorMessage('No available AI tabs! Ensure Brave/Chrome companion is active.');
      } else {
        this.view?.webview.postMessage({
          type: 'LOG_STEP',
          step: `Routing to ${routeResult.provider}...`
        });
      }
    }
  }

  private async handleTerminalAutoFix() {
    const editor = vscode.window.activeTextEditor;
    const errorSnippet = await this.terminalWatcher.promptForTerminalFix();
    if (!errorSnippet) return;

    const doc = editor ? editor.document : null;
    const fileContent = doc ? doc.getText() : '';
    const fileName = doc ? doc.fileName.split(/[\\/]/).pop() || 'file' : '';

    const promptText = `Terminal error detected:
\`\`\`
${errorSnippet}
\`\`\`
Please analyze this error and provide an explanation or fix.`;

    await this.handleUserPrompt(promptText, 'auto');
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AiDot</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #18181b);
      --card-bg: var(--vscode-editorWidget-background, #27272a);
      --card-border: var(--vscode-widget-border, #3f3f46);
      --fg: var(--vscode-foreground, #f4f4f5);
      --muted: var(--vscode-descriptionForeground, #a1a1aa);
      --accent: var(--vscode-button-background, #3b82f6);
      --accent-hover: var(--vscode-button-hoverBackground, #2563eb);
      --input-bg: var(--vscode-input-background, #202023);
      --input-border: var(--vscode-input-border, #3f3f46);
      --user-msg: var(--vscode-editor-inactiveSelectionBackground, #3f3f46);
      --ai-msg: var(--vscode-editor-background, #1e1e20);
      --code-bg: var(--vscode-textCodeBlock-background, #141416);
      --green: #22c55e;
      --red: #ef4444;
      --radius: 8px;
    }

    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: 13px;
      color: var(--fg);
      background-color: var(--bg);
      margin: 0;
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Top Bar */
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--card-border);
      background: var(--bg);
      gap: 8px;
    }

    .brand-title {
      font-weight: 600;
      font-size: 13px;
      letter-spacing: -0.2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .session-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    button.icon-btn {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--muted);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }

    button.icon-btn:hover {
      color: var(--fg);
      border-color: var(--accent);
      background: var(--card-bg);
    }

    /* Sessions Drawer */
    .sessions-dropdown {
      display: none;
      padding: 8px 12px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      max-height: 140px;
      overflow-y: auto;
      flex-direction: column;
      gap: 4px;
    }

    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      color: var(--muted);
    }

    .session-item:hover, .session-item.active {
      background: var(--user-msg);
      color: var(--fg);
    }

    .delete-btn {
      opacity: 0.6;
      font-size: 10px;
      padding: 2px 4px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
    }
    .delete-btn:hover { opacity: 1; color: var(--red); }

    /* Model Status Bar */
    .status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 14px;
      font-size: 11px;
      color: var(--muted);
      border-bottom: 1px solid var(--card-border);
      background: rgba(0,0,0,0.1);
    }

    .tabs-status-chips {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .chip {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 12px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .chip.online {
      color: #86efac;
      border-color: #166534;
      background: rgba(34, 197, 94, 0.1);
    }

    .chip-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    /* Chat Messages View */
    .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .message-bubble {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 100%;
      line-height: 1.5;
      font-size: 12.5px;
      word-break: break-word;
    }

    .user-msg-wrapper {
      align-self: flex-end;
      background: var(--user-msg);
      color: var(--fg);
      padding: 8px 12px;
      border-radius: 12px 12px 2px 12px;
      max-width: 88%;
      border: 1px solid var(--card-border);
    }

    .ai-msg-wrapper {
      align-self: flex-start;
      background: var(--ai-msg);
      padding: 10px 14px;
      border-radius: 12px 12px 12px 2px;
      border: 1px solid var(--card-border);
      width: 100%;
    }

    .sender-header {
      font-size: 11px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .message-text {
      white-space: pre-wrap;
    }

    .code-snippet {
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      overflow-x: auto;
      white-space: pre;
    }

    /* Diff Review Card */
    .diff-action-card {
      background: rgba(37, 99, 235, 0.12);
      border: 1px solid var(--accent);
      border-radius: var(--radius);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 8px 14px;
    }

    .diff-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      display: flex;
      justify-content: space-between;
    }

    .diff-btn-row {
      display: flex;
      gap: 8px;
    }

    .diff-btn {
      flex: 1;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      border: none;
      cursor: pointer;
    }

    .diff-btn.accept {
      background: var(--green);
      color: #000;
    }

    .diff-btn.reject {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--fg);
    }

    /* Loading Animation */
    .loading-bubble {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      font-size: 12px;
      color: var(--muted);
      background: var(--ai-msg);
      border: 1px solid var(--card-border);
      border-radius: 12px 12px 12px 2px;
      width: fit-content;
    }

    .pulse-dot {
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: pulse 1.2s infinite ease-in-out;
    }
    .pulse-dot:nth-child(2) { animation-delay: 0.2s; }
    .pulse-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes pulse {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1.1); opacity: 1; }
    }

    /* Arena Results Carousel / List */
    .arena-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }

    .arena-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    /* Context Pill (@file) */
    .context-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 14px;
      font-size: 11px;
      color: var(--muted);
    }

    .context-pill {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 2px 8px;
      color: var(--accent);
      font-size: 11px;
    }

    /* Autocomplete Dropdown (@ mentions) */
    .mention-dropdown {
      position: absolute;
      bottom: 110px;
      left: 14px;
      right: 14px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      max-height: 160px;
      overflow-y: auto;
      display: none;
      flex-direction: column;
      z-index: 100;
    }

    .mention-item {
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .mention-item:hover, .mention-item.selected {
      background: var(--user-msg);
      color: var(--accent);
    }

    /* Input Footer */
    .input-wrapper {
      padding: 10px 14px 12px 14px;
      border-top: 1px solid var(--card-border);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 8px;
      position: relative;
    }

    .controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    select.mode-dropdown {
      background: var(--input-bg);
      color: var(--fg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11.5px;
      flex: 1;
      outline: none;
    }

    .prompt-box {
      width: 100%;
      background: var(--input-bg);
      color: var(--fg);
      border: 1px solid var(--input-border);
      border-radius: var(--radius);
      padding: 10px 12px;
      font-family: inherit;
      font-size: 12.5px;
      resize: none;
      min-height: 60px;
      max-height: 180px;
      outline: none;
      line-height: 1.4;
    }

    .prompt-box:focus {
      border-color: var(--accent);
    }

    .submit-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .submit-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .submit-btn:hover {
      background: var(--accent-hover);
    }

    .fix-term-btn {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--muted);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11.5px;
      cursor: pointer;
    }
    .fix-term-btn:hover { color: var(--fg); border-color: var(--accent); }
  </style>
</head>
<body>

  <!-- Top Navigation & Sessions -->
  <div class="top-bar">
    <div class="brand-title">AiDot</div>
    <div class="session-actions">
      <button id="sessionsToggle" class="icon-btn">History</button>
      <button id="newChatBtn" class="icon-btn">+ New</button>
    </div>
  </div>

  <!-- Sessions Dropdown Drawer -->
  <div id="sessionsDropdown" class="sessions-dropdown"></div>

  <!-- Model Connectivity Status -->
  <div class="status-row">
    <span>Free Web Chats:</span>
    <div id="tabsChips" class="tabs-status-chips"></div>
  </div>

  <!-- Active File Context Banner -->
  <div class="context-bar">
    <span>Active:</span>
    <span id="activeFilePill" class="context-pill">None (Type @ to mention)</span>
  </div>

  <!-- Diff Review Banner (When surgical edits are waiting) -->
  <div id="diffBanner" class="diff-action-card" style="display: none;">
    <div class="diff-title">
      <span>Diff Ready for Review</span>
      <span style="font-size:11px; opacity:0.8;">Native diff active</span>
    </div>
    <div class="diff-btn-row">
      <button id="acceptDiffBtn" class="diff-btn accept">Accept Changes</button>
      <button id="rejectDiffBtn" class="diff-btn reject">Reject</button>
    </div>
  </div>

  <!-- Chat Log View -->
  <div id="chatContainer" class="chat-container">
    <div class="message-bubble ai-msg-wrapper">
      <div class="sender-header">AiDot</div>
      <div class="message-text">Hello! I am connected to your open free AI tabs (Claude, ChatGPT, Gemini, DeepSeek). Ask me to explain code, refactor functions, or type <b>@</b> to reference files!</div>
    </div>
  </div>

  <!-- Autocomplete Popover for @ mentions -->
  <div id="mentionDropdown" class="mention-dropdown"></div>

  <!-- Prompt Input & Controls -->
  <div class="input-wrapper">
    <div class="controls-row">
      <select id="modeSelect" class="mode-dropdown">
        <option value="auto">Auto-Failover (Claude → ChatGPT → Gemini → DeepSeek)</option>
        <option value="arena">Arena Mode (Ask All Connected AI)</option>
        <option value="Claude">Claude Web</option>
        <option value="ChatGPT">ChatGPT Web</option>
        <option value="Gemini">Gemini Web</option>
        <option value="DeepSeek">DeepSeek Web</option>
      </select>
    </div>

    <textarea id="promptInput" class="prompt-box" rows="2" placeholder="Ask a question or request a code change (type @ for file)..."></textarea>

    <div class="submit-row">
      <button id="fixTerminalBtn" class="fix-term-btn">Fix Terminal Error</button>
      <button id="sendBtn" class="submit-btn">Send</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const initialState = vscode.getState() || {};

    const ALL_PROVIDERS = ['Claude', 'ChatGPT', 'Gemini', 'DeepSeek'];
    let workspaceFiles = [];
    let mentionStartIndex = -1;
    let selectedMentionIndex = 0;
    let isWaitingForResponse = !!initialState.isWaitingForResponse;
    let currentWaitingTarget = initialState.currentWaitingTarget || 'AI';
    window.arenaResultsCache = initialState.arenaResults || null;
    window.arenaIsComplete = !!initialState.isArenaComplete;
    window.lastRenderedMessages = [];

    // DOM Elements
    const chatContainer = document.getElementById('chatContainer');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const modeSelect = document.getElementById('modeSelect');
    const tabsChips = document.getElementById('tabsChips');
    const activeFilePill = document.getElementById('activeFilePill');
    const diffBanner = document.getElementById('diffBanner');
    const acceptDiffBtn = document.getElementById('acceptDiffBtn');
    const rejectDiffBtn = document.getElementById('rejectDiffBtn');
    const fixTerminalBtn = document.getElementById('fixTerminalBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const sessionsToggle = document.getElementById('sessionsToggle');
    const sessionsDropdown = document.getElementById('sessionsDropdown');
    const mentionDropdown = document.getElementById('mentionDropdown');

    // Restore saved input and mode
    if (initialState.draftPrompt) {
      promptInput.value = initialState.draftPrompt;
    }
    if (initialState.mode) {
      modeSelect.value = initialState.mode;
    }
    if (isWaitingForResponse) {
      showLoadingBubble(currentWaitingTarget);
    }

    function persistState(overrides = {}) {
      const cur = vscode.getState() || {};
      const updated = {
        ...cur,
        draftPrompt: promptInput ? promptInput.value : '',
        mode: modeSelect ? modeSelect.value : 'auto',
        isWaitingForResponse,
        currentWaitingTarget,
        arenaResults: window.arenaResultsCache,
        isArenaComplete: window.arenaIsComplete,
        ...overrides
      };
      vscode.setState(updated);
    }

    modeSelect.addEventListener('change', () => {
      persistState();
    });

    // Toggle Sessions Drawer
    sessionsToggle.addEventListener('click', () => {
      sessionsDropdown.style.display = sessionsDropdown.style.display === 'flex' ? 'none' : 'flex';
    });

    newChatBtn.addEventListener('click', () => {
      promptInput.value = '';
      window.arenaResultsCache = null;
      window.arenaIsComplete = false;
      isWaitingForResponse = false;
      removeLoadingBubble();
      const existing = document.getElementById('arenaChatBlock');
      if (existing) existing.remove();
      persistState({ draftPrompt: '', arenaResults: null, isArenaComplete: false, isWaitingForResponse: false });
      vscode.postMessage({ type: 'NEW_SESSION' });
    });

    sendBtn.addEventListener('click', submitPrompt);

    promptInput.addEventListener('keydown', (e) => {
      if (mentionDropdown.style.display === 'flex') {
        const items = mentionDropdown.querySelectorAll('.mention-item');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedMentionIndex = (selectedMentionIndex + 1) % items.length;
          updateSelectedMention(items);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedMentionIndex = (selectedMentionIndex - 1 + items.length) % items.length;
          updateSelectedMention(items);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (items[selectedMentionIndex]) {
            items[selectedMentionIndex].click();
          }
          return;
        }
        if (e.key === 'Escape') {
          closeMentions();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    promptInput.addEventListener('input', (e) => {
      persistState();
      vscode.postMessage({ type: 'DRAFT_UPDATE', draft: promptInput.value });

      const text = promptInput.value;
      const cursorPos = promptInput.selectionStart;
      const atIndex = text.lastIndexOf('@', cursorPos - 1);

      if (atIndex !== -1 && (atIndex === 0 || /\s/.test(text[atIndex - 1]))) {
        const query = text.substring(atIndex + 1, cursorPos);
        if (!query.includes(' ')) {
          mentionStartIndex = atIndex;
          vscode.postMessage({ type: 'GET_WORKSPACE_FILES', query });
          return;
        }
      }
      closeMentions();
    });

    function closeMentions() {
      mentionDropdown.style.display = 'none';
      mentionStartIndex = -1;
    }

    function updateSelectedMention(items) {
      items.forEach((item, idx) => {
        item.classList.toggle('selected', idx === selectedMentionIndex);
      });
    }

    function submitPrompt() {
      const prompt = promptInput.value.trim();
      if (!prompt) return;

      const mode = modeSelect.value;
      const isPinned = !['auto', 'arena'].includes(mode);

      // Set state and show loader
      isWaitingForResponse = true;
      currentWaitingTarget = isPinned ? mode : (mode === 'arena' ? 'All AI tabs' : 'AI');
      if (mode === 'arena') {
        window.arenaResultsCache = [];
        window.arenaIsComplete = false;
        const existing = document.getElementById('arenaChatBlock');
        if (existing) existing.remove();
      }
      showLoadingBubble(currentWaitingTarget);

      vscode.postMessage({
        type: 'SEND_PROMPT',
        prompt,
        mode: isPinned ? 'pinned' : mode,
        preferredProvider: isPinned ? mode : undefined
      });

      promptInput.value = '';
      persistState({ draftPrompt: '' });
      vscode.postMessage({ type: 'DRAFT_UPDATE', draft: '' });
      closeMentions();
    }

    function showLoadingBubble(target) {
      removeLoadingBubble();
      const bubble = document.createElement('div');
      bubble.id = 'loadingBubble';
      bubble.className = 'loading-bubble';
      bubble.innerHTML = \`
        <div class="pulse-dot"></div>
        <div class="pulse-dot"></div>
        <div class="pulse-dot"></div>
        <span style="margin-left:4px;">Thinking with \${escapeHtml(target)}...</span>
      \`;
      chatContainer.appendChild(bubble);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function removeLoadingBubble() {
      const el = document.getElementById('loadingBubble');
      if (el) el.remove();
    }

    acceptDiffBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'ACCEPT_DIFF' });
    });

    rejectDiffBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'REJECT_DIFF' });
    });

    fixTerminalBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'FIX_TERMINAL' });
    });

    // Inbound messages from Extension Host
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'RESTORE_STATE') {
        if (!promptInput.value && msg.draftPrompt) {
          promptInput.value = msg.draftPrompt;
        }
        if (msg.isWaiting) {
          isWaitingForResponse = true;
          currentWaitingTarget = msg.waitingTarget || 'AI';
          showLoadingBubble(currentWaitingTarget);
        } else if (!msg.isWaiting && isWaitingForResponse && !window.arenaResultsCache) {
          isWaitingForResponse = false;
          removeLoadingBubble();
        }
        if (msg.arenaResults && msg.arenaResults.length > 0) {
          window.arenaResultsCache = msg.arenaResults;
          window.arenaIsComplete = !!msg.isArenaComplete;
          renderArenaInChat(msg.arenaResults, msg.isArenaComplete);
        }
        persistState();
      }

      if (msg.type === 'STATUS_UPDATE') {
        renderChips(msg.connected || []);
        if (msg.hasPendingDiff) {
          diffBanner.style.display = 'flex';
        }
      }

      if (msg.type === 'ACTIVE_FILE_UPDATE') {
        activeFilePill.textContent = msg.fileName ? msg.fileName : 'None (Type @ to mention)';
      }

      if (msg.type === 'SESSIONS_UPDATE') {
        // Keep loading bubble if a response is pending
        const hasPendingAiMsg = msg.activeMessages && msg.activeMessages.length > 0 &&
                                msg.activeMessages[msg.activeMessages.length - 1].sender === 'assistant';
        if (hasPendingAiMsg) {
          isWaitingForResponse = false;
          removeLoadingBubble();
          persistState();
        }
        renderSessionsDrawer(msg.sessions || [], msg.activeSessionId);
        renderMessages(msg.activeMessages || []);
        if (!hasPendingAiMsg && isWaitingForResponse) {
          showLoadingBubble(currentWaitingTarget);
        }
      }

      if (msg.type === 'ARENA_RESULTS') {
        window.arenaResultsCache = msg.results || [];
        window.arenaIsComplete = !!msg.isComplete;
        if (msg.isComplete) {
          isWaitingForResponse = false;
          removeLoadingBubble();
        }
        renderArenaInChat(msg.results || [], msg.isComplete);
        persistState();
      }

      if (msg.type === 'DIFF_READY') {
        diffBanner.style.display = 'flex';
      }

      if (msg.type === 'DIFF_CLEARED') {
        diffBanner.style.display = 'none';
      }

      if (msg.type === 'WORKSPACE_FILES_RESULT') {
        renderMentions(msg.files || []);
      }
    });

    function renderChips(connectedList) {
      tabsChips.innerHTML = '';
      ALL_PROVIDERS.forEach(provider => {
        const isOnline = connectedList.includes(provider);
        const chip = document.createElement('div');
        chip.className = 'chip ' + (isOnline ? 'online' : '');
        chip.innerHTML = \`<span class="chip-dot"></span> \${provider}\`;
        tabsChips.appendChild(chip);
      });
    }

    function renderSessionsDrawer(sessions, activeId) {
      sessionsDropdown.innerHTML = '';
      sessions.forEach(s => {
        const div = document.createElement('div');
        div.className = 'session-item ' + (s.id === activeId ? 'active' : '');
        div.innerHTML = \`
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:85%;">\${escapeHtml(s.title)}</span>
          <button class="delete-btn" title="Delete">✕</button>
        \`;
        div.addEventListener('click', (e) => {
          if (e.target.classList.contains('delete-btn')) {
            vscode.postMessage({ type: 'DELETE_SESSION', sessionId: s.id });
          } else {
            vscode.postMessage({ type: 'SWITCH_SESSION', sessionId: s.id });
            sessionsDropdown.style.display = 'none';
          }
        });
        sessionsDropdown.appendChild(div);
      });
    }

    function renderMessages(messages) {
      window.lastRenderedMessages = messages || [];
      chatContainer.innerHTML = '';
      if (!messages || messages.length === 0) {
        chatContainer.innerHTML = \`
          <div class="message-bubble ai-msg-wrapper">
            <div class="sender-header">AiDot</div>
            <div class="message-text">New conversation started. Ask any question or request code modifications!</div>
          </div>
        \`;
      } else {
        messages.forEach(msg => {
          const bubble = document.createElement('div');
          bubble.className = 'message-bubble ' + (msg.sender === 'user' ? 'user-msg-wrapper' : 'ai-msg-wrapper');

          if (msg.provider === 'Arena' && msg.arenaResults && msg.arenaResults.length > 0) {
            bubble.innerHTML = \`<div class="sender-header">⚔️ Arena Mode Responses</div>\`;
            const grid = document.createElement('div');
            grid.className = 'arena-grid';
            msg.arenaResults.forEach(res => {
              const hasDiff = res.code && res.code.includes('<<<<<<< SEARCH') && 
                              res.code.includes('>>>>>>> REPLACE') && 
                              !res.code.includes('exact lines to find in original file');
              const displayText = res.rawText || res.code || '';
              const card = document.createElement('div');
              card.className = 'arena-card';
              card.innerHTML = \`
                <div style="font-weight:600; font-size:12px; display:flex; justify-content:space-between; margin-bottom:4px;">
                  <span style="color:var(--accent);">\${escapeHtml(res.provider)}</span>
                  <span style="font-size:10px; color:var(--green);">Ready</span>
                </div>
                <div style="font-size:12px; line-height:1.5; max-height:220px; overflow-y:auto; white-space:pre-wrap; color:var(--fg); margin-bottom:6px;">\${escapeHtml(displayText)}</div>
                \${hasDiff ? \`
                  <button class="icon-btn" style="align-self:flex-start;" onclick="previewArenaDiff('\${escapeHtml(res.provider)}')">
                    Preview \${escapeHtml(res.provider)} Diff
                  </button>
                \` : ''}
              \`;
              grid.appendChild(card);
            });
            bubble.appendChild(grid);
            chatContainer.appendChild(bubble);
            return;
          }

          let html = '';
          if (msg.sender === 'assistant') {
            html += \`<div class="sender-header">\${escapeHtml(msg.provider || 'AiDot')}</div>\`;
          }

          html += \`<div class="message-text">\${escapeHtml(msg.text)}</div>\`;

          if (msg.code && msg.code !== msg.text) {
            html += \`<div class="code-snippet">\${escapeHtml(msg.code)}</div>\`;
          }

          if (msg.hasDiff && msg.code) {
            html += \`
              <div style="margin-top:6px; display:flex; gap:8px;">
                <button class="icon-btn" onclick="previewDiffCode('\${escapeHtml(msg.id)}')">
                  🔍 Preview Proposed Diff
                </button>
              </div>
            \`;
          }

          bubble.innerHTML = html;
          chatContainer.appendChild(bubble);
        });
      }

      // Re-append active or in-flight Arena cards if not already part of session messages
      const lastMsg = messages && messages.length > 0 ? messages[messages.length - 1] : null;
      const lastMsgHasSameArena = lastMsg && lastMsg.provider === 'Arena' && lastMsg.arenaResults;
      if (!lastMsgHasSameArena && window.arenaResultsCache && window.arenaResultsCache.length > 0) {
        renderArenaInChat(window.arenaResultsCache, window.arenaIsComplete);
      }

      // Restore loading indicator if active
      if (isWaitingForResponse) {
        showLoadingBubble(currentWaitingTarget);
      }

      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function renderMentions(files) {
      if (files.length === 0) {
        closeMentions();
        return;
      }

      mentionDropdown.innerHTML = '';
      selectedMentionIndex = 0;
      files.slice(0, 8).forEach((f, idx) => {
        const item = document.createElement('div');
        item.className = 'mention-item ' + (idx === 0 ? 'selected' : '');
        item.textContent = f.path;
        item.addEventListener('click', () => {
          const text = promptInput.value;
          const before = text.substring(0, mentionStartIndex);
          const after = text.substring(promptInput.selectionStart);
          promptInput.value = before + '@' + f.path + ' ' + after;
          promptInput.focus();
          persistState();
          vscode.postMessage({ type: 'DRAFT_UPDATE', draft: promptInput.value });
          closeMentions();
        });
        mentionDropdown.appendChild(item);
      });

      mentionDropdown.style.display = 'flex';
    }

    function renderArenaInChat(results, isComplete) {
      let existing = document.getElementById('arenaChatBlock');
      if (!existing) {
        existing = document.createElement('div');
        existing.id = 'arenaChatBlock';
        existing.className = 'message-bubble ai-msg-wrapper';
        existing.innerHTML = \`<div class="sender-header">⚔️ Arena Mode Responses</div><div class="arena-grid" id="arenaGrid"></div>\`;
        chatContainer.appendChild(existing);
      }

      const grid = document.getElementById('arenaGrid');
      grid.innerHTML = '';
      results.forEach(res => {
        const hasDiff = res.code && res.code.includes('<<<<<<< SEARCH') && 
                        res.code.includes('>>>>>>> REPLACE') && 
                        !res.code.includes('exact lines to find in original file');
        const displayText = res.rawText || res.code || '';
        const card = document.createElement('div');
        card.className = 'arena-card';
        card.innerHTML = \`
          <div style="font-weight:600; font-size:12px; display:flex; justify-content:space-between; margin-bottom:4px;">
            <span style="color:var(--accent);">\${escapeHtml(res.provider)}</span>
            <span style="font-size:10px; color:var(--green);">\${isComplete ? 'Ready' : 'Streaming...'}</span>
          </div>
          <div style="font-size:12px; line-height:1.5; max-height:220px; overflow-y:auto; white-space:pre-wrap; color:var(--fg); margin-bottom:6px;">\${escapeHtml(displayText)}</div>
          \${hasDiff ? \`
            <button class="icon-btn" style="align-self:flex-start;" onclick="previewArenaDiff('\${escapeHtml(res.provider)}')">
              Preview \${escapeHtml(res.provider)} Diff
            </button>
          \` : ''}
        \`;
        grid.appendChild(card);
      });
      window.arenaResultsCache = results;
      window.arenaIsComplete = isComplete;
      persistState();
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    window.previewArenaDiff = function(provider) {
      let match = (window.arenaResultsCache || []).find(r => r.provider === provider);
      if (!match && window.lastRenderedMessages) {
        for (let i = window.lastRenderedMessages.length - 1; i >= 0; i--) {
          const m = window.lastRenderedMessages[i];
          if (m.arenaResults) {
            const found = m.arenaResults.find(r => r.provider === provider);
            if (found) {
              match = found;
              break;
            }
          }
        }
      }
      if (match && match.code) {
        vscode.postMessage({
          type: 'PREVIEW_ARENA_DIFF',
          code: match.code,
          provider
        });
      }
    };

    window.previewDiffCode = function(msgId) {
      const msg = (window.lastRenderedMessages || []).find(m => m.id === msgId);
      if (msg && msg.code) {
        vscode.postMessage({
          type: 'PREVIEW_ARENA_DIFF',
          code: msg.code,
          provider: msg.provider || 'AiDot'
        });
      }
    };

    function escapeHtml(text) {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Initialize
    vscode.postMessage({ type: 'GET_STATUS' });
  </script>
</body>
</html>`;
  }
}

