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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const wsServer_1 = require("./server/wsServer");
const router_1 = require("./orchestrator/router");
const arena_1 = require("./orchestrator/arena");
const agentLoop_1 = require("./orchestrator/agentLoop");
const diffManager_1 = require("./diff/diffManager");
const terminalWatcher_1 = require("./terminal/terminalWatcher");
const sidebarProvider_1 = require("./sidebar/sidebarProvider");
let server;
async function activate(context) {
    console.log('[AiDot] Extension activating...');
    // 1. Initialize Core Services
    server = new wsServer_1.WsBridgeServer(8765);
    const router = new router_1.MultiProviderRouter(server);
    const arena = new arena_1.ArenaOrchestrator(server);
    const diffManager = new diffManager_1.DiffManager();
    const agentLoop = new agentLoop_1.AgentLoop(router, diffManager);
    const terminalWatcher = new terminalWatcher_1.TerminalWatcher();
    // Register virtual document provider for diff preview
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(diffManager_1.DiffManager.SCHEME, diffManager));
    // 2. Register Sidebar Webview
    const sidebarProvider = new sidebarProvider_1.SidebarProvider(context.extensionUri, router, arena, agentLoop, diffManager, terminalWatcher, context.globalState);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebarProvider_1.SidebarProvider.viewType, sidebarProvider));
    // Sync active file when user switches editor files
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        sidebarProvider.syncActiveFileContext();
    }));
    // 3. Setup WebSocket message handling from Chrome Companion
    server.onMessage(async (msg) => {
        switch (msg.type) {
            case 'REGISTER_PROVIDER': {
                router.registerProvider(msg.provider);
                sidebarProvider.syncStatus();
                vscode.window.showInformationMessage(`AiDot: ${msg.provider} web tab connected!`);
                break;
            }
            case 'PROVIDER_DISCONNECTED': {
                router.disconnectProvider(msg.provider);
                sidebarProvider.syncStatus();
                break;
            }
            case 'RATE_LIMIT_HIT': {
                vscode.window.showWarningMessage(`AiDot: ${msg.provider} hit free tier limit! Auto-failing over...`);
                const next = router.handleRateLimitHit(msg.provider, msg.requestId);
                if (next) {
                    vscode.window.showInformationMessage(`AiDot: Prompt forwarded to ${next.nextProvider}`);
                }
                else {
                    vscode.window.showErrorMessage('AiDot: All connected AI tabs have hit rate limits or are disconnected.');
                }
                sidebarProvider.syncStatus();
                break;
            }
            case 'CODE_RESPONSE': {
                if (msg.isArena) {
                    arena.handleResponse(msg.provider, msg.code, msg.rawText, msg.requestId);
                }
                else {
                    router.clearRequest(msg.requestId || '');
                    let targetDoc = null;
                    const targetUri = diffManager.getTargetFileUri();
                    if (targetUri) {
                        try {
                            targetDoc = await vscode.workspace.openTextDocument(targetUri);
                        }
                        catch (e) {
                            console.warn('[AiDot] Could not open target file URI:', e);
                        }
                    }
                    if (!targetDoc) {
                        const editor = vscode.window.activeTextEditor;
                        if (editor && editor.document.uri.scheme === 'file') {
                            targetDoc = editor.document;
                        }
                    }
                    let hasDiff = false;
                    const isRealDiff = msg.code.includes('<<<<<<< SEARCH') &&
                        msg.code.includes('>>>>>>> REPLACE') &&
                        !msg.code.includes('exact lines to find in original file');
                    if (targetDoc && isRealDiff) {
                        hasDiff = await diffManager.previewDiff(targetDoc, msg.code);
                        if (hasDiff) {
                            vscode.window.showInformationMessage(`AiDot: Diff proposed by ${msg.provider}. Review changes!`);
                        }
                    }
                    // Log response in chat history view
                    sidebarProvider.handleIncomingAIResponse(msg.provider, msg.fullText || msg.rawText || msg.code, msg.code, hasDiff);
                    sidebarProvider.syncStatus();
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
            }
            catch (e) {
                console.error('[AiDot] Error syncing selectors.json:', e);
            }
        }
    }
    catch (err) {
        vscode.window.showErrorMessage(`AiDot failed to start server on port 8765: ${err}`);
    }
    // 5. Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('aidot.askAI', async () => {
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
            prompt: 'AiDot: What changes should the AI make in this file?'
        });
        if (!instruction)
            return;
        const doc = editor.document;
        const fullPrompt = agentLoop.buildSystemPrompt(instruction, doc.getText(), doc.fileName.split(/[\\/]/).pop() || 'file');
        router.routePrompt(fullPrompt, instruction);
    }), vscode.commands.registerCommand('aidot.fixTerminalError', async () => {
        vscode.commands.executeCommand('aidot.sidebar.focus');
    }), vscode.commands.registerCommand('aidot.acceptDiff', async () => {
        await diffManager.acceptDiff();
        sidebarProvider.syncStatus();
    }), vscode.commands.registerCommand('aidot.rejectDiff', async () => {
        await diffManager.rejectDiff();
        sidebarProvider.syncStatus();
    }));
}
function deactivate() {
    if (server) {
        server.stop();
    }
}
//# sourceMappingURL=extension.js.map