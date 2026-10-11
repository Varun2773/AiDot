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
exports.AgentLoop = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class AgentLoop {
    router;
    diffManager;
    maxIterations = 5;
    currentIteration = 0;
    isRunning = false;
    onStepCallback = null;
    constructor(router, diffManager) {
        this.router = router;
        this.diffManager = diffManager;
    }
    setStepCallback(cb) {
        this.onStepCallback = cb;
    }
    logStep(message) {
        if (this.onStepCallback) {
            this.onStepCallback(message);
        }
    }
    buildSystemPrompt(userTask, fileContext, fileName, extraContext) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const fileSnippet = fileContext ? `Current File (${fileName}):\n\`\`\`\n${fileContext}\n\`\`\`\n` : '';
        const extraSnippet = extraContext ? `Referenced Context:\n${extraContext}\n` : '';
        return `You are AiDot, a sophisticated AI coding companion running directly inside VS Code.
Workspace root: ${workspaceRoot}

${fileSnippet}${extraSnippet}User Prompt:
${userTask}

INSTRUCTIONS:
IMPORTANT: Do NOT repeat, quote, or echo back these instructions or the system prompt preamble. Start directly with your answer.

1. If the user asks a question, requests an explanation, or asks for code analysis (e.g. "explain this function", "how does this work?"):
   - Respond directly and clearly in concise Markdown with explanations, bullet points, or code snippets.
   - Do NOT output SEARCH/REPLACE blocks for informational/question queries.

2. If the user asks you to modify, fix, refactor, or edit code:
   - Provide a brief summary of the changes followed by one or more surgical SEARCH/REPLACE blocks formatted exactly like:
\`\`\`
<<<<<<< SEARCH
exact lines to find in original file
=======
replacement lines
>>>>>>> REPLACE
\`\`\`

3. If you need to inspect more files or run a terminal command:
   <read_file path="path/to/file"/>
   <list_dir path="folder/path"/>
   <run_command cmd="command to run"/>`;
    }
    /**
     * Parses structured XML tags emitted by the AI
     */
    parseAction(output) {
        const readFileMatch = /<read_file path="([^"]+)"\s*\/>/.exec(output);
        if (readFileMatch) {
            return { type: 'READ_FILE', arg: readFileMatch[1] };
        }
        const listDirMatch = /<list_dir path="([^"]+)"\s*\/>/.exec(output);
        if (listDirMatch) {
            return { type: 'LIST_DIR', arg: listDirMatch[1] };
        }
        const runCmdMatch = /<run_command cmd="([^"]+)"\s*\/>/.exec(output);
        if (runCmdMatch) {
            return { type: 'RUN_COMMAND', arg: runCmdMatch[1] };
        }
        if (output.includes('<<<<<<< SEARCH') && output.includes('>>>>>>> REPLACE')) {
            return { type: 'APPLY_DIFF', payload: output };
        }
        return { type: 'FINAL_ANSWER', payload: output };
    }
    /**
     * Executes tools and returns context to inject into next conversation turn
     */
    async executeTool(action, baseUri) {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        switch (action.type) {
            case 'READ_FILE': {
                const filePath = path.resolve(rootPath, action.arg || '');
                this.logStep(`📖 Reading file: ${action.arg}`);
                if (!fs.existsSync(filePath)) {
                    return `Error: File not found at ${action.arg}`;
                }
                const content = fs.readFileSync(filePath, 'utf-8');
                return `File content of ${action.arg}:\n\`\`\`\n${content}\n\`\`\``;
            }
            case 'LIST_DIR': {
                const dirPath = path.resolve(rootPath, action.arg || '');
                this.logStep(`📁 Listing directory: ${action.arg}`);
                if (!fs.existsSync(dirPath)) {
                    return `Error: Directory not found at ${action.arg}`;
                }
                const files = fs.readdirSync(dirPath);
                return `Directory contents of ${action.arg}:\n${files.join('\n')}`;
            }
            case 'RUN_COMMAND': {
                const cmd = action.arg || '';
                this.logStep(`⚡ Requesting permission to run terminal command: ${cmd}`);
                // Safety prompt for user approval
                const answer = await vscode.window.showInformationMessage(`AiDot wants to run terminal command: "${cmd}". Allow?`, 'Yes, Run', 'Cancel');
                if (answer !== 'Yes, Run') {
                    return 'Command execution was cancelled by user.';
                }
                const terminal = vscode.window.createTerminal('AiDot Terminal');
                terminal.show();
                terminal.sendText(cmd);
                return `Command "${cmd}" sent to terminal.`;
            }
            case 'APPLY_DIFF': {
                this.logStep(`🔍 Opening side-by-side diff preview...`);
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    await this.diffManager.previewDiff(editor.document, action.payload || '');
                    return 'Diff preview displayed to user for review.';
                }
                return 'No active editor found to display diff.';
            }
            default:
                return action.payload || '';
        }
    }
}
exports.AgentLoop = AgentLoop;
//# sourceMappingURL=agentLoop.js.map