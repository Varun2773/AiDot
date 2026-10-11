import * as vscode from 'vscode';
import { Patcher } from './patcher';

export class DiffManager implements vscode.TextDocumentContentProvider {
  public static readonly SCHEME = 'aidot-diff';
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public onDidChange = this.onDidChangeEmitter.event;

  private pendingProposedContent: string = '';
  private targetEditorUri: vscode.Uri | null = null;
  private currentDiffUri: vscode.Uri | null = null;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.pendingProposedContent;
  }

  /**
   * Generates patched code, opens side-by-side diff in VS Code
   */
  public async previewDiff(targetDoc: vscode.TextDocument, aiOutput: string): Promise<boolean> {
    const originalText = targetDoc.getText();
    const blocks = Patcher.parseBlocks(aiOutput);

    let updatedText = '';
    if (blocks.length > 0) {
      const result = Patcher.applyBlocks(originalText, blocks);
      if (result.appliedCount === 0) {
        vscode.window.showWarningMessage('aiDot: Found SEARCH/REPLACE blocks, but none matched the current file lines.');
        return false;
      }
      updatedText = result.updatedText;
    } else {
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
  public async acceptDiff(): Promise<boolean> {
    if (!this.targetEditorUri || !this.pendingProposedContent) {
      vscode.window.showWarningMessage('No pending diff to accept.');
      return false;
    }

    const doc = await vscode.workspace.openTextDocument(this.targetEditorUri);
    const editor = await vscode.window.showTextDocument(doc);

    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );

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
  public async rejectDiff(): Promise<void> {
    this.clear();
    vscode.window.showInformationMessage('❌ aiDot: Proposed changes rejected.');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }

  public hasPendingDiff(): boolean {
    return !!this.pendingProposedContent;
  }

  public getProposedContent(): string {
    return this.pendingProposedContent;
  }

  private clear() {
    this.pendingProposedContent = '';
    this.targetEditorUri = null;
    this.currentDiffUri = null;
  }
}
