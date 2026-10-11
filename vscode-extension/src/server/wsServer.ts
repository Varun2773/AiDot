import { WebSocketServer, WebSocket } from 'ws';
import * as vscode from 'vscode';
import { IncomingChromeMessage, ProviderName, SendPromptMessage, UpdateSelectorsMessage } from './protocol';

export class WsBridgeServer {
  private wss: WebSocketServer | null = null;
  private clientSockets: Set<WebSocket> = new Set();
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
          this.clientSockets.add(ws);
          console.log('[AiDot Server] Chrome Bridge Companion Connected (Active clients:', this.clientSockets.size, ')');

          ws.on('message', (data: string | Buffer) => {
            try {
              const parsed = JSON.parse(data.toString()) as IncomingChromeMessage;
              for (const handler of this.messageHandlers) {
                handler(parsed);
              }
            } catch (err) {
              console.error('[AiDot Server] Failed to parse message:', err);
            }
          });

          ws.on('close', () => {
            this.clientSockets.delete(ws);
            console.log('[AiDot Server] Chrome Bridge Companion Disconnected (Remaining:', this.clientSockets.size, ')');
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
    return this.clientSockets.size > 0;
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
    const payload = JSON.stringify(message);
    let sentAny = false;
    for (const socket of this.clientSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
        sentAny = true;
      }
    }
    return sentAny;
  }

  public syncSelectors(selectors: Record<string, any>) {
    if (this.isConnected()) {
      const message: UpdateSelectorsMessage = {
        type: 'UPDATE_SELECTORS',
        selectors
      };
      const payload = JSON.stringify(message);
      for (const socket of this.clientSockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      }
    }
  }

  public stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      this.clientSockets.clear();
    }
  }
}
