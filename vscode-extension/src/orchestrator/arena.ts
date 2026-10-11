import { ProviderName } from '../server/protocol';
import { WsBridgeServer } from '../server/wsServer';

export interface ArenaResult {
  provider: ProviderName;
  code: string;
  rawText?: string;
  timestamp: number;
}

export class ArenaOrchestrator {
  private server: WsBridgeServer;
  private currentArenaId: string | null = null;
  private pendingProviders = new Set<ProviderName>();
  private collectedResults: ArenaResult[] = [];
  private onResultsUpdateListener: ((results: ArenaResult[], isComplete: boolean) => void) | null = null;

  constructor(server: WsBridgeServer) {
    this.server = server;
  }

  public onResultsUpdate(listener: (results: ArenaResult[], isComplete: boolean) => void) {
    this.onResultsUpdateListener = listener;
  }

  /**
   * Broadcast prompt to all connected providers simultaneously
   */
  public broadcastToAll(connectedProviders: ProviderName[], fullPrompt: string): { arenaId: string; targets: ProviderName[] } | null {
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
  public handleResponse(provider: ProviderName, code: string, rawText?: string, arenaId?: string): boolean {
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

  public getResults(): ArenaResult[] {
    return this.collectedResults;
  }

  public isPending(): boolean {
    return this.pendingProviders.size > 0;
  }

  public getPendingProviders(): ProviderName[] {
    return [...this.pendingProviders];
  }

  public reset() {
    this.currentArenaId = null;
    this.pendingProviders.clear();
    this.collectedResults = [];
  }
}

