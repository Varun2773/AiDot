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
exports.TerminalWatcher = void 0;
const vscode = __importStar(require("vscode"));
class TerminalWatcher {
    lastErrorText = '';
    constructor() {
        // Standard terminal watcher using stable VS Code APIs
        // Listens for terminal closures / execution lifecycle
        vscode.window.onDidCloseTerminal((terminal) => {
            if (terminal.exitStatus && terminal.exitStatus.code !== 0) {
                this.lastErrorText = `Terminal "${terminal.name}" exited with error code ${terminal.exitStatus.code}.`;
            }
        });
    }
    setLastError(errorSnippet) {
        this.lastErrorText = errorSnippet;
    }
    getLastError() {
        return this.lastErrorText;
    }
    /**
     * Prompts user or retrieves active clipboard/error snippet to form fix prompt
     */
    async promptForTerminalFix() {
        const errorSnippet = this.lastErrorText || (await vscode.env.clipboard.readText());
        const userPrompt = await vscode.window.showInputBox({
            prompt: 'Terminal Error Auto-Fix: Confirm or edit error snippet to send to AI',
            value: errorSnippet.slice(0, 1000),
            placeHolder: 'Paste or type terminal error here...'
        });
        return userPrompt || null;
    }
}
exports.TerminalWatcher = TerminalWatcher;
//# sourceMappingURL=terminalWatcher.js.map