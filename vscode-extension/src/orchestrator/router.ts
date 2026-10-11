import * as vscode from 'vscode';
import { ProviderName } from '../server/protocol';
import { WsBridgeServer } from '../server/wsServer';

export interface PendingPromptRequest {
  id: string;
  originalInstruction: string;
  fullPrompt: string;
  attemptedProviders: Set<ProviderName>;
  preferredProvider?: ProviderName;
  isArena?: boolean;
}

export class MultiProviderRouter {
  private server: WsBridgeServer;
  private connectedProviders = new Set<ProviderName>();
  private exhaustedProviders = new Set<ProviderName>();
  private priorityOrder: ProviderName[] = ['Claude', 'ChatGPT', 'Gemini', 'DeepSeek'];
  private pendingRequests = new Map<string, PendingPromptRequest>();

  constructor(server: WsBridgeServer) {
    this.server = server;
  }

  public registerProvider(provider: ProviderName) {
    this.connectedProviders.add(provider);
    this.exhaustedProviders.delete(provider);
  }

  public disconnectProvider(provider: ProviderName) {
    this.connectedProviders.delete(provider);
  }

  public getConnectedProviders(): ProviderName[] {
    return Array.from(this.connectedProviders);
  }

  public getAvailableProviders(): ProviderName[] {
    return this.priorityOrder.filter(
      p => this.connectedProviders.has(p) && !this.exhaustedProviders.has(p)
    );
  }

  public markExhausted(provider: ProviderName) {
    this.exhaustedProviders.add(provider);
  }

  public resetExhausted() {
    this.exhaustedProviders.clear();
  }

  /**
   * Auto-Rotator: Routes prompt to preferred provider or next available in priority order
   */
  public routePrompt(
    fullPrompt: string,
    originalInstruction: string,
    preferredProvider?: ProviderName,
    requestId?: string
  ): { provider: ProviderName; reqId: string } | null {
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    
    let pending = this.pendingRequests.get(reqId);
    if (!pending) {
      pending = {
        id: reqId,
        originalInstruction,
        fullPrompt,
        attemptedProviders: new Set<ProviderName>(),
        preferredProvider
      };
      this.pendingRequests.set(reqId, pending);
    }

    // Determine target provider
    let targetProvider: ProviderName | undefined;

    if (
      preferredProvider &&
      this.connectedProviders.has(preferredProvider) &&
      !this.exhaustedProviders.has(preferredProvider) &&
      !pending.attemptedProviders.has(preferredProvider)
    ) {
      targetProvider = preferredProvider;
    } else {
      // Pick next unattempted and unexhausted provider from priority order
      targetProvider = this.priorityOrder.find(
        p => this.connectedProviders.has(p) && !this.exhaustedProviders.has(p) && !pending!.attemptedProviders.has(p)
      );
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
  public handleRateLimitHit(provider: ProviderName, reqId?: string): { nextProvider: ProviderName; reqId: string } | null {
    this.markExhausted(provider);

    if (reqId && this.pendingRequests.has(reqId)) {
      const pending = this.pendingRequests.get(reqId)!;
      const res = this.routePrompt(pending.fullPrompt, pending.originalInstruction, undefined, reqId);
      if (res) {
        return { nextProvider: res.provider, reqId: res.reqId };
      }
    }

    return null;
  }

  public clearRequest(reqId: string) {
    this.pendingRequests.delete(reqId);
  }
}
