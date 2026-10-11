/**
 * aiDot WebSocket Protocol Definitions
 */

export type ProviderName = 'Claude' | 'ChatGPT' | 'Gemini' | 'DeepSeek';

export interface BaseMessage {
  type: string;
  requestId?: string;
}

export interface RegisterProviderMessage extends BaseMessage {
  type: 'REGISTER_PROVIDER';
  provider: ProviderName;
}

export interface ProviderDisconnectedMessage extends BaseMessage {
  type: 'PROVIDER_DISCONNECTED';
  provider: ProviderName;
}

export interface RateLimitHitMessage extends BaseMessage {
  type: 'RATE_LIMIT_HIT';
  provider: ProviderName;
  originalPrompt: string;
  reason?: string;
}

export interface CodeResponseMessage extends BaseMessage {
  type: 'CODE_RESPONSE';
  provider: ProviderName;
  code: string;
  rawText?: string;
  isArena?: boolean;
}

export interface StatusLogMessage extends BaseMessage {
  type: 'STATUS_LOG';
  provider: ProviderName;
  message: string;
}

export interface SendPromptMessage extends BaseMessage {
  type: 'SEND_PROMPT';
  provider: ProviderName;
  prompt: string;
  requestId: string;
  isArena?: boolean;
}

export interface UpdateSelectorsMessage extends BaseMessage {
  type: 'UPDATE_SELECTORS';
  selectors: Record<string, any>;
}

export type IncomingChromeMessage =
  | RegisterProviderMessage
  | ProviderDisconnectedMessage
  | RateLimitHitMessage
  | CodeResponseMessage
  | StatusLogMessage;
