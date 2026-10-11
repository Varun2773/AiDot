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
exports.WsBridgeServer = void 0;
const ws_1 = require("ws");
const vscode = __importStar(require("vscode"));
class WsBridgeServer {
    wss = null;
    clientSockets = new Set();
    port;
    messageHandlers = [];
    connectionChangeHandlers = [];
    constructor(port = 8765) {
        this.port = port;
    }
    start() {
        return new Promise((resolve, reject) => {
            try {
                this.wss = new ws_1.WebSocketServer({ port: this.port });
                this.wss.on('connection', (ws) => {
                    this.clientSockets.add(ws);
                    console.log('[AiDot Server] Chrome Bridge Companion Connected (Active clients:', this.clientSockets.size, ')');
                    ws.on('message', (data) => {
                        try {
                            const parsed = JSON.parse(data.toString());
                            for (const handler of this.messageHandlers) {
                                handler(parsed);
                            }
                        }
                        catch (err) {
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
            }
            catch (err) {
                reject(err);
            }
        });
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onConnectionChange(handler) {
        this.connectionChangeHandlers.push(handler);
    }
    notifyConnectionChange() {
        for (const handler of this.connectionChangeHandlers) {
            handler();
        }
    }
    isConnected() {
        return this.clientSockets.size > 0;
    }
    sendPrompt(provider, prompt, requestId, isArena = false) {
        if (!this.isConnected()) {
            return false;
        }
        const message = {
            type: 'SEND_PROMPT',
            provider,
            prompt,
            requestId,
            isArena
        };
        const payload = JSON.stringify(message);
        let sentAny = false;
        for (const socket of this.clientSockets) {
            if (socket.readyState === ws_1.WebSocket.OPEN) {
                socket.send(payload);
                sentAny = true;
            }
        }
        return sentAny;
    }
    syncSelectors(selectors) {
        if (this.isConnected()) {
            const message = {
                type: 'UPDATE_SELECTORS',
                selectors
            };
            const payload = JSON.stringify(message);
            for (const socket of this.clientSockets) {
                if (socket.readyState === ws_1.WebSocket.OPEN) {
                    socket.send(payload);
                }
            }
        }
    }
    stop() {
        if (this.wss) {
            this.wss.close();
            this.wss = null;
            this.clientSockets.clear();
        }
    }
}
exports.WsBridgeServer = WsBridgeServer;
//# sourceMappingURL=wsServer.js.map