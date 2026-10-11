import * as vscode from 'vscode';
import { Patcher } from './patcher';

export class DiffManager implements vscode.TextDocumentContentProvider {
  public static readonly SCHEME = 'aidot-diff';
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public onDidChange = this.onDidChangeEmitter.event;

  private pendingProposedContent: string = '';
  private originalSnapshot: string = '';
  private targetEditorUri: vscode.Uri | null = null;
  private currentDiffUri: vscode.Uri | null = null;

  public setTargetFileUri(uri: vscode.Uri | null) {
    this.targetEditorUri = uri;
  }

  public getTargetFileUri(): vscode.Uri | null {
    return this.targetEditorUri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.pendingProposedContent;
  }

  /**
   * Safely closes any open native diff editor tabs matching DiffManager.SCHEME
   */
  public async closeDiffEditor(): Promise<void> {
    try {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as any;
          if (
            input &&
            ((input.modified && input.modified.scheme === DiffManager.SCHEME) ||
             (input.original && input.original.scheme === DiffManager.SCHEME))
          ) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
    } catch (e) {
      console.warn('[AiDot] Error closing diff tab:', e);
    }

    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === DiffManager.SCHEME) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  }

  /**
   * Generates patched code, opens side-by-side diff in VS Code
   */
  public async previewDiff(targetDoc: vscode.TextDocument, aiOutput: string): Promise<boolean> {
    // Prevent diffing against another diff tab
    if (targetDoc.uri.scheme === DiffManager.SCHEME) {
      if (this.targetEditorUri) {
        targetDoc = await vscode.workspace.openTextDocument(this.targetEditorUri);
      } else {
        return false;
      }
    }

    const originalText = targetDoc.getText();
    this.originalSnapshot = originalText;
    const blocks = Patcher.parseBlocks(aiOutput);

    let updatedText = '';
    if (blocks.length > 0) {
      const result = Patcher.applyBlocks(originalText, blocks);
      if (result.appliedCount === 0) {
        vscode.window.showWarningMessage('AiDot: Found SEARCH/REPLACE blocks, but none matched the current file lines.');
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

    const title = `AiDot Proposed Changes ↔ ${fileName}`;
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
      await doc.save();
      vscode.window.showInformationMessage('✅ AiDot: Changes accepted and applied successfully!');
      this.clear();
      await this.closeDiffEditor();
    }
    return success;
  }

  /**
   * Rejects proposed diff and closes the diff tab
   */
  public async rejectDiff(): Promise<void> {
    const targetUri = this.targetEditorUri;
    const snapshot = this.originalSnapshot;
    this.clear();
    await this.closeDiffEditor();
    if (targetUri) {
      try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const editor = await vscode.window.showTextDocument(doc);
        // If document was dirty or modified, restore snapshot byte-for-byte and save
        if (snapshot && doc.getText() !== snapshot) {
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );
          await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, snapshot);
          });
          await doc.save();
        } else if (doc.isDirty) {
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
      } catch (e) {
        console.warn('[AiDot] Error restoring doc on reject:', e);
      }
    }
    vscode.window.showInformationMessage('❌ AiDot: Proposed changes rejected. File untouched.');
  }

  public hasPendingDiff(): boolean {
    return !!this.pendingProposedContent;
  }

  public getProposedContent(): string {
    return this.pendingProposedContent;
  }

  private clear() {
    this.pendingProposedContent = '';
    this.originalSnapshot = '';
    this.targetEditorUri = null;
    this.currentDiffUri = null;
  }
}

