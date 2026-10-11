import * as vscode from 'vscode';

export class TerminalWatcher {
  private lastErrorText: string = '';

  constructor() {
    // If proposed onDidWriteTerminalData is available in proposed API environments, attach it safely
    const win = vscode.window as any;
    if (typeof win.onDidWriteTerminalData === 'function') {
      win.onDidWriteTerminalData((e: any) => {
        const text = e.data || '';
        if (text.includes('Error:') || text.includes('ERR!') || text.includes('FAILED') || text.includes('Exception')) {
          this.lastErrorText = text;
        }
      });
    }
  }

  public setLastError(errorSnippet: string) {
    this.lastErrorText = errorSnippet;
  }

  public getLastError(): string {
    return this.lastErrorText;
  }

  /**
   * Prompts user or retrieves active clipboard/error snippet to form fix prompt
   */
  public async promptForTerminalFix(): Promise<string | null> {
    const errorSnippet = this.lastErrorText || (await vscode.env.clipboard.readText());

    const userPrompt = await vscode.window.showInputBox({
      prompt: 'Terminal Error Auto-Fix: Confirm or edit error snippet to send to AI',
      value: errorSnippet.slice(0, 1000),
      placeHolder: 'Paste or type terminal error here...'
    });

    return userPrompt || null;
  }
}
