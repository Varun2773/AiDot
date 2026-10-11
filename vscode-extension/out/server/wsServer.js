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
    clientSocket = null;
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
                    this.clientSocket = ws;
                    console.log('[aiDot Server] Chrome Bridge Companion Connected');
                    ws.on('message', (data) => {
                        try {
                            const parsed = JSON.parse(data.toString());
                            for (const handler of this.messageHandlers) {
                                handler(parsed);
                            }
                        }
                        catch (err) {
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
        return this.clientSocket !== null && this.clientSocket.readyState === ws_1.WebSocket.OPEN;
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
        this.clientSocket.send(JSON.stringify(message));
        return true;
    }
    syncSelectors(selectors) {
        if (this.isConnected()) {
            const message = {
                type: 'UPDATE_SELECTORS',
                selectors
            };
            this.clientSocket.send(JSON.stringify(message));
        }
    }
    stop() {
        if (this.wss) {
            this.wss.close();
            this.wss = null;
            this.clientSocket = null;
        }
    }
}
exports.WsBridgeServer = WsBridgeServer;
//# sourceMappingURL=wsServer.js.map