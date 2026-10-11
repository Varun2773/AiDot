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
exports.DiffManager = void 0;
const vscode = __importStar(require("vscode"));
const patcher_1 = require("./patcher");
class DiffManager {
    static SCHEME = 'aidot-diff';
    onDidChangeEmitter = new vscode.EventEmitter();
    onDidChange = this.onDidChangeEmitter.event;
    pendingProposedContent = '';
    targetEditorUri = null;
    currentDiffUri = null;
    provideTextDocumentContent(uri) {
        return this.pendingProposedContent;
    }
    /**
     * Generates patched code, opens side-by-side diff in VS Code
     */
    async previewDiff(targetDoc, aiOutput) {
        const originalText = targetDoc.getText();
        const blocks = patcher_1.Patcher.parseBlocks(aiOutput);
        let updatedText = '';
        if (blocks.length > 0) {
            const result = patcher_1.Patcher.applyBlocks(originalText, blocks);
            if (result.appliedCount === 0) {
                vscode.window.showWarningMessage('aiDot: Found SEARCH/REPLACE blocks, but none matched the current file lines.');
                return false;
            }
            updatedText = result.updatedText;
        }
        else {
            // If AI returned full file without diff markers
            updatedText = aiOutput.trim();
        }
        this.pendingProposedContent = updatedText;
        this.targetEditorUri = targetDoc.uri;
        const fileName = targetDoc.fileName.split(/[\\/]/).pop() || 'file';
        this.currentDiffUri = vscode.Uri.parse(`${DiffManager.SCHEME}://preview/${fileName}`);
        this.onDidChangeEmitter.fire(this.currentDiffUri);
        const title = `aiDot Proposed Changes ↔ ${fileName}`;
        await vscode.commands.executeCommand('vscode.diff', targetDoc.uri, this.currentDiffUri, title);
        return true;
    }
    /**
     * Accepts proposed diff and writes it directly to the active document buffer
     */
    async acceptDiff() {
        if (!this.targetEditorUri || !this.pendingProposedContent) {
            vscode.window.showWarningMessage('No pending diff to accept.');
            return false;
        }
        const doc = await vscode.workspace.openTextDocument(this.targetEditorUri);
        const editor = await vscode.window.showTextDocument(doc);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        const success = await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, this.pendingProposedContent);
        });
        if (success) {
            vscode.window.showInformationMessage('✅ aiDot: Changes accepted and applied successfully!');
            this.clear();
            // Close the diff tab if open
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
        return success;
    }
    /**
     * Rejects proposed diff and closes the diff tab
     */
    async rejectDiff() {
        this.clear();
        vscode.window.showInformationMessage('❌ aiDot: Proposed changes rejected.');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    hasPendingDiff() {
        return !!this.pendingProposedContent;
    }
    getProposedContent() {
        return this.pendingProposedContent;
    }
    clear() {
        this.pendingProposedContent = '';
        this.targetEditorUri = null;
        this.currentDiffUri = null;
    }
}
exports.DiffManager = DiffManager;
//# sourceMappingURL=diffManager.js.map