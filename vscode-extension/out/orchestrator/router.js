"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiProviderRouter = void 0;
class MultiProviderRouter {
    server;
    connectedProviders = new Set();
    exhaustedProviders = new Set();
    priorityOrder = ['Claude', 'ChatGPT', 'Gemini', 'DeepSeek'];
    pendingRequests = new Map();
    constructor(server) {
        this.server = server;
    }
    registerProvider(provider) {
        this.connectedProviders.add(provider);
        this.exhaustedProviders.delete(provider);
    }
    disconnectProvider(provider) {
        this.connectedProviders.delete(provider);
    }
    getConnectedProviders() {
        return Array.from(this.connectedProviders);
    }
    getAvailableProviders() {
        return this.priorityOrder.filter(p => this.connectedProviders.has(p) && !this.exhaustedProviders.has(p));
    }
    markExhausted(provider) {
        this.exhaustedProviders.add(provider);
    }
    resetExhausted() {
        this.exhaustedProviders.clear();
    }
    /**
     * Auto-Rotator: Routes prompt to preferred provider or next available in priority order
     */
    routePrompt(fullPrompt, originalInstruction, preferredProvider, requestId) {
        const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        let pending = this.pendingRequests.get(reqId);
        if (!pending) {
            pending = {
                id: reqId,
                originalInstruction,
                fullPrompt,
                attemptedProviders: new Set(),
                preferredProvider
            };
            this.pendingRequests.set(reqId, pending);
        }
        // Determine target provider
        let targetProvider;
        if (preferredProvider &&
            this.connectedProviders.has(preferredProvider) &&
            !this.exhaustedProviders.has(preferredProvider) &&
            !pending.attemptedProviders.has(preferredProvider)) {
            targetProvider = preferredProvider;
        }
        else {
            // Pick next unattempted and unexhausted provider from priority order
            targetProvider = this.priorityOrder.find(p => this.connectedProviders.has(p) && !this.exhaustedProviders.has(p) && !pending.attemptedProviders.has(p));
        }
        if (!targetProvider) {
            return null;
        }
        pending.attemptedProviders.add(targetProvider);
        const sent = this.server.sendPrompt(targetProvider, fullPrompt, reqId, false);
        if (!sent) {
            return null;
        }
        return { provider: targetProvider, reqId };
    }
    /**
     * Failover logic triggered when a tab hits rate limits
     */
    handleRateLimitHit(provider, reqId) {
        this.markExhausted(provider);
        if (reqId && this.pendingRequests.has(reqId)) {
            const pending = this.pendingRequests.get(reqId);
            const res = this.routePrompt(pending.fullPrompt, pending.originalInstruction, undefined, reqId);
            if (res) {
                return { nextProvider: res.provider, reqId: res.reqId };
            }
        }
        return null;
    }
    clearRequest(reqId) {
        this.pendingRequests.delete(reqId);
    }
}
exports.MultiProviderRouter = MultiProviderRouter;
//# sourceMappingURL=router.js.map