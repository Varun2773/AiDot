import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WsBridgeServer } from './server/wsServer';
import { MultiProviderRouter } from './orchestrator/router';
import { ArenaOrchestrator } from './orchestrator/arena';
import { AgentLoop } from './orchestrator/agentLoop';
import { DiffManager } from './diff/diffManager';
import { TerminalWatcher } from './terminal/terminalWatcher';
import { SidebarProvider } from './sidebar/sidebarProvider';
import { ProviderName } from './server/protocol';

let server: WsBridgeServer;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[aiDot] Extension activating...');

  // 1. Initialize Core Services
  server = new WsBridgeServer(8765);
  const router = new MultiProviderRouter(server);
  const arena = new ArenaOrchestrator(server);
  const diffManager = new DiffManager();
  const agentLoop = new AgentLoop(router, diffManager);
  const terminalWatcher = new TerminalWatcher();

  // Register virtual document provider for diff preview
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DiffManager.SCHEME, diffManager)
  );

  // 2. Register Sidebar Webview
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    router,
    arena,
    agentLoop,
    diffManager,
    terminalWatcher
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
  );

  // 3. Setup WebSocket message handling from Chrome Companion
  server.onMessage(async (msg) => {
    switch (msg.type) {
      case 'REGISTER_PROVIDER': {
        router.registerProvider(msg.provider);
        sidebarProvider.syncStatus();
        vscode.window.showInformationMessage(`aiDot: ${msg.provider} web tab connected!`);
        break;
      }

      case 'PROVIDER_DISCONNECTED': {
        router.disconnectProvider(msg.provider);
        sidebarProvider.syncStatus();
        break;
      }

      case 'RATE_LIMIT_HIT': {
        vscode.window.showWarningMessage(`aiDot: ${msg.provider} hit free tier limit! Auto-failing over...`);
        const next = router.handleRateLimitHit(msg.provider, msg.requestId);
        if (next) {
          vscode.window.showInformationMessage(`aiDot: Prompt forwarded to ${next.nextProvider}`);
        } else {
          vscode.window.showErrorMessage('aiDot: All connected AI tabs have hit rate limits or are disconnected.');
        }
        sidebarProvider.syncStatus();
        break;
      }

      case 'CODE_RESPONSE': {
        if (msg.isArena) {
          arena.handleResponse(msg.provider, msg.code, msg.rawText, msg.requestId);
        } else {
          router.clearRequest(msg.requestId || '');
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const hasDiff = await diffManager.previewDiff(editor.document, msg.code);
            if (hasDiff) {
              vscode.window.showInformationMessage(`aiDot: Received response from ${msg.provider}. Diff opened for review!`);
              sidebarProvider.syncStatus();
            }
          }
        }
        break;
      }
    }
  });

  server.onConnectionChange(() => {
    sidebarProvider.syncStatus();
  });

  // 4. Start WebSocket Server
  try {
    await server.start();
    // Load and sync selectors.json to Chrome
    const selectorsPath = path.join(context.extensionPath, 'selectors.json');
    if (fs.existsSync(selectorsPath)) {
      try {
        const raw = fs.readFileSync(selectorsPath, 'utf-8');
        const selectorsData = JSON.parse(raw);
        server.syncSelectors(selectorsData.providers);
      } catch (e) {
        console.error('[aiDot] Error syncing selectors.json:', e);
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`aiDot failed to start server on port 8765: ${err}`);
  }

  // 5. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aidot.askAI', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Open a file first!');
        return;
      }

      const available = router.getAvailableProviders();
      if (available.length === 0) {
        vscode.window.showErrorMessage('No active web chat tabs connected! Open Claude, ChatGPT, Gemini, or DeepSeek.');
        return;
      }

      const instruction = await vscode.window.showInputBox({
        prompt: 'aiDot: What changes should the AI make in this file?'
      });
      if (!instruction) return;

      const doc = editor.document;
      const fullPrompt = agentLoop.buildSystemPrompt(instruction, doc.getText(), doc.fileName.split(/[\\/]/).pop() || 'file');
      router.routePrompt(fullPrompt, instruction);
    }),

    vscode.commands.registerCommand('aidot.fixTerminalError', async () => {
      vscode.commands.executeCommand('aidot.sidebar.focus');
    }),

    vscode.commands.registerCommand('aidot.acceptDiff', async () => {
      await diffManager.acceptDiff();
      sidebarProvider.syncStatus();
    }),

    vscode.commands.registerCommand('aidot.rejectDiff', async () => {
      await diffManager.rejectDiff();
      sidebarProvider.syncStatus();
    })
  );
}

export function deactivate() {
  if (server) {
    server.stop();
  }
}
