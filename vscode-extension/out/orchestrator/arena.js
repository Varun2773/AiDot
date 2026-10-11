"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArenaOrchestrator = void 0;
class ArenaOrchestrator {
    server;
    currentArenaId = null;
    pendingProviders = new Set();
    collectedResults = [];
    onResultsUpdateListener = null;
    constructor(server) {
        this.server = server;
    }
    onResultsUpdate(listener) {
        this.onResultsUpdateListener = listener;
    }
    /**
     * Broadcast prompt to all connected providers simultaneously
     */
    broadcastToAll(connectedProviders, fullPrompt) {
        if (connectedProviders.length === 0) {
            return null;
        }
        this.currentArenaId = `arena_${Date.now()}`;
        this.pendingProviders = new Set(connectedProviders);
        this.collectedResults = [];
        for (const provider of connectedProviders) {
            this.server.sendPrompt(provider, fullPrompt, this.currentArenaId, true);
        }
        return {
            arenaId: this.currentArenaId,
            targets: [...connectedProviders]
        };
    }
    /**
     * Records incoming response for the arena contest
     */
    handleResponse(provider, code, rawText, arenaId) {
        if (arenaId && this.currentArenaId !== arenaId) {
            return false;
        }
        this.collectedResults.push({
            provider,
            code,
            rawText,
            timestamp: Date.now()
        });
        this.pendingProviders.delete(provider);
        const isComplete = this.pendingProviders.size === 0;
        if (this.onResultsUpdateListener) {
            this.onResultsUpdateListener([...this.collectedResults], isComplete);
        }
        return true;
    }
    getResults() {
        return this.collectedResults;
    }
    isPending() {
        return this.pendingProviders.size > 0;
    }
    getPendingProviders() {
        return [...this.pendingProviders];
    }
    reset() {
        this.currentArenaId = null;
        this.pendingProviders.clear();
        this.collectedResults = [];
    }
}
exports.ArenaOrchestrator = ArenaOrchestrator;
//# sourceMappingURL=arena.js.map