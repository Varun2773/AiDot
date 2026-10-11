import * as vscode from 'vscode';

export class TerminalWatcher {
  private lastErrorText: string = '';

  constructor() {
    // Standard terminal watcher using stable VS Code APIs
    // Listens for terminal closures / execution lifecycle
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal.exitStatus && terminal.exitStatus.code !== 0) {
        this.lastErrorText = `Terminal "${terminal.name}" exited with error code ${terminal.exitStatus.code}.`;
      }
    });
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
