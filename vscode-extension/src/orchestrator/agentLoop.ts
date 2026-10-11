import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MultiProviderRouter } from './router';
import { DiffManager } from '../diff/diffManager';

export interface AgentAction {
  type: 'READ_FILE' | 'LIST_DIR' | 'RUN_COMMAND' | 'APPLY_DIFF' | 'FINAL_ANSWER';
  arg?: string;
  payload?: string;
}

export class AgentLoop {
  private router: MultiProviderRouter;
  private diffManager: DiffManager;
  private maxIterations = 5;
  private currentIteration = 0;
  private isRunning = false;
  private onStepCallback: ((step: string) => void) | null = null;

  constructor(router: MultiProviderRouter, diffManager: DiffManager) {
    this.router = router;
    this.diffManager = diffManager;
  }

  public setStepCallback(cb: (step: string) => void) {
    this.onStepCallback = cb;
  }

  private logStep(message: string) {
    if (this.onStepCallback) {
      this.onStepCallback(message);
    }
  }

  public buildSystemPrompt(userTask: string, fileContext: string, fileName: string, extraContext?: string): string {
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
  public parseAction(output: string): AgentAction {
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
  public async executeTool(action: AgentAction, baseUri?: vscode.Uri): Promise<string> {
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
        const answer = await vscode.window.showInformationMessage(
          `AiDot wants to run terminal command: "${cmd}". Allow?`,
          'Yes, Run',
          'Cancel'
        );

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
