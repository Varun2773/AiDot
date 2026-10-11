import { WebSocketServer, WebSocket } from 'ws';
import * as vscode from 'vscode';
import { IncomingChromeMessage, ProviderName, SendPromptMessage, UpdateSelectorsMessage } from './protocol';

export class WsBridgeServer {
  private wss: WebSocketServer | null = null;
  private clientSocket: WebSocket | null = null;
  private port: number;
  private messageHandlers: ((msg: IncomingChromeMessage) => void)[] = [];
  private connectionChangeHandlers: (() => void)[] = [];

  constructor(port = 8765) {
    this.port = port;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port });

        this.wss.on('connection', (ws: WebSocket) => {
          this.clientSocket = ws;
          console.log('[aiDot Server] Chrome Bridge Companion Connected');

          ws.on('message', (data: string | Buffer) => {
            try {
              const parsed = JSON.parse(data.toString()) as IncomingChromeMessage;
              for (const handler of this.messageHandlers) {
                handler(parsed);
              }
            } catch (err) {
              console.error('[aiDot Server] Failed to parse message:', err);
            }
          });

          ws.on('close', () => {
            console.log('[aiDot Server] Chrome Bridge Companion Disconnected');
            this.clientSocket = null;
            this.notifyConnectionChange();
          });

          this.notifyConnectionChange();
        });

        this.wss.on('listening', () => {
          console.log(`[aiDot Server] Listening on ws://localhost:${this.port}`);
          resolve();
        });

        this.wss.on('error', (err) => {
          vscode.window.showErrorMessage(`aiDot Server Error: ${err.message}`);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  public onMessage(handler: (msg: IncomingChromeMessage) => void) {
    this.messageHandlers.push(handler);
  }

  public onConnectionChange(handler: () => void) {
    this.connectionChangeHandlers.push(handler);
  }

  private notifyConnectionChange() {
    for (const handler of this.connectionChangeHandlers) {
      handler();
    }
  }

  public isConnected(): boolean {
    return this.clientSocket !== null && this.clientSocket.readyState === WebSocket.OPEN;
  }

  public sendPrompt(provider: ProviderName, prompt: string, requestId: string, isArena = false): boolean {
    if (!this.isConnected()) {
      return false;
    }
    const message: SendPromptMessage = {
      type: 'SEND_PROMPT',
      provider,
      prompt,
      requestId,
      isArena
    };
    this.clientSocket!.send(JSON.stringify(message));
    return true;
  }

  public syncSelectors(selectors: Record<string, any>) {
    if (this.isConnected()) {
      const message: UpdateSelectorsMessage = {
        type: 'UPDATE_SELECTORS',
        selectors
      };
      this.clientSocket!.send(JSON.stringify(message));
    }
  }

  public stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      this.clientSocket = null;
    }
  }
}
