/**
 * aiDot Chrome Extension - Background Service Worker
 * Manages persistent WebSocket connection to VS Code (ws://localhost:8765)
 * Bypasses webpage CSP/Mixed-Content restrictions and routes messages between VS Code and tabs.
 */

const VSCODE_WS_URL = 'ws://localhost:8765';
let ws = null;
let reconnectTimer = null;
let activeTabs = new Map(); // providerName -> tabId

console.log('[aiDot ServiceWorker] Started');

function connectToVSCode() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(VSCODE_WS_URL);

    ws.onopen = () => {
      console.log('[aiDot ServiceWorker] Connected to VS Code WebSocket server');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      // Query open AI tabs and announce them to VS Code
      queryAndRegisterAllTabs();
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        handleVSCodeMessage(message);
      } catch (err) {
        console.error('[aiDot ServiceWorker] Error parsing message from VS Code:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[aiDot ServiceWorker] WebSocket error:', err);
    };

    ws.onclose = () => {
      console.log('[aiDot ServiceWorker] WebSocket connection closed. Retrying in 3s...');
      ws = null;
      scheduleReconnect();
    };
  } catch (e) {
    console.error('[aiDot ServiceWorker] Failed to create WebSocket:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToVSCode();
    }, 3000);
  }
}

function sendToVSCode(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.warn('[aiDot ServiceWorker] Cannot send to VS Code, socket not open:', payload.type);
  }
}

/**
 * Handle incoming messages from VS Code
 */
async function handleVSCodeMessage(message) {
  switch (message.type) {
    case 'SEND_PROMPT': {
      const { provider, prompt, requestId, isArena } = message;
      const tabId = activeTabs.get(provider);

      if (!tabId) {
        console.warn(`[aiDot ServiceWorker] No active tab registered for provider: ${provider}`);
        sendToVSCode({
          type: 'ERROR',
          provider,
          requestId,
          error: `Tab for ${provider} is not open or not connected.`
        });
        return;
      }

      // Relay prompt to tab content script
      chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_PROMPT',
        prompt,
        requestId,
        isArena
      }, async (response) => {
        if (chrome.runtime.lastError || !response) {
          console.warn(`[aiDot ServiceWorker] Tab ${tabId} message failed, re-injecting content script...`);
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content.js']
            });
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, {
                type: 'EXECUTE_PROMPT',
                prompt,
                requestId,
                isArena
              });
            }, 300);
          } catch (e) {
            console.error('[aiDot ServiceWorker] Re-injection failed:', e);
            sendToVSCode({
              type: 'RATE_LIMIT_HIT',
              provider,
              requestId,
              originalPrompt: prompt,
              reason: 'Tab unreachable or script execution blocked'
            });
          }
        }
      });
      break;
    }

    case 'UPDATE_SELECTORS': {
      // Forward new selectors config to all active tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'APPLY_SELECTORS',
            selectors: message.selectors
          }, () => {
            // Ignore error for non-matching tabs
            chrome.runtime.lastError;
          });
        });
      });
      break;
    }

    case 'PING': {
      sendToVSCode({ type: 'PONG' });
      break;
    }
  }
}

/**
 * Listen for messages from Content Scripts (running in ChatGPT, Claude, Gemini, DeepSeek tabs)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'REGISTER_TAB': {
      const { provider } = message;
      if (tabId && provider) {
        activeTabs.set(provider, tabId);
        console.log(`[aiDot ServiceWorker] Registered ${provider} on tab ${tabId}`);
        sendToVSCode({
          type: 'REGISTER_PROVIDER',
          provider
        });
      }
      sendResponse({ status: 'registered' });
      break;
    }

    case 'CODE_RESPONSE':
    case 'RATE_LIMIT_HIT':
    case 'STREAM_UPDATE':
    case 'STATUS_LOG': {
      // Forward directly to VS Code
      sendToVSCode(message);
      sendResponse({ status: 'forwarded' });
      break;
    }
  }
  return true;
});

// Clean up disconnected tabs
chrome.tabs.onRemoved.addListener((closedTabId) => {
  for (const [provider, id] of activeTabs.entries()) {
    if (id === closedTabId) {
      activeTabs.delete(provider);
      console.log(`[aiDot ServiceWorker] Tab for ${provider} was closed`);
      sendToVSCode({
        type: 'PROVIDER_DISCONNECTED',
        provider
      });
      break;
    }
  }
});

const AI_DOMAINS = [
  { match: 'chatgpt.com', provider: 'ChatGPT' },
  { match: 'claude.ai', provider: 'Claude' },
  { match: 'gemini.google.com', provider: 'Gemini' },
  { match: 'deepseek.com', provider: 'DeepSeek' }
];

async function queryAndRegisterAllTabs() {
  chrome.tabs.query({}, async (tabs) => {
    for (const tab of tabs) {
      if (!tab.url) continue;

      const matchedDomain = AI_DOMAINS.find(d => tab.url.includes(d.match));
      if (matchedDomain) {
        // Try messaging the content script first
        chrome.tabs.sendMessage(tab.id, { type: 'QUERY_PROVIDER' }, async (response) => {
          if (chrome.runtime.lastError || !response || !response.provider) {
            // Content script was not yet injected into this tab (e.g. opened before extension loaded)
            try {
              console.log(`[aiDot ServiceWorker] Injecting content script into ${matchedDomain.provider} tab: ${tab.id}`);
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
              });
              activeTabs.set(matchedDomain.provider, tab.id);
              sendToVSCode({
                type: 'REGISTER_PROVIDER',
                provider: matchedDomain.provider
              });
            } catch (err) {
              console.warn('[aiDot ServiceWorker] Could not inject content script:', err);
            }
          } else {
            activeTabs.set(response.provider, tab.id);
            sendToVSCode({
              type: 'REGISTER_PROVIDER',
              provider: response.provider
            });
          }
        });
      }
    }
  });
}

// Watch for newly navigated or updated tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const matchedDomain = AI_DOMAINS.find(d => tab.url.includes(d.match));
    if (matchedDomain) {
      activeTabs.set(matchedDomain.provider, tabId);
      sendToVSCode({
        type: 'REGISTER_PROVIDER',
        provider: matchedDomain.provider
      });
    }
  }
});

// Initial connection
connectToVSCode();

// Keep service worker awake / reconnect check every 25s
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectToVSCode();
  }
}, 25000);
