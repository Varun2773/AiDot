/**
 * aiDot Chrome Extension - Content Script
 * Injected into chatgpt.com, claude.ai, gemini.google.com, chat.deepseek.com
 * Automates text injection, click submission, mutation tracking, rate-limit spotting, and code extraction.
 */

const DEFAULT_ADAPTERS = {
  'chatgpt.com': {
    name: 'ChatGPT',
    inputSelector: '#prompt-textarea',
    sendBtnSelector: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
    stopBtnSelector: 'button[data-testid="stop-button"]',
    codeSelector: 'pre code',
    limitKeywords: [
      'reached your',
      'usage cap',
      'limit of messages',
      'upgrade to plus',
      'too many requests'
    ]
  },
  'claude.ai': {
    name: 'Claude',
    inputSelector: 'div.ProseMirror[contenteditable="true"]',
    sendBtnSelector: 'button[aria-label="Send Message"], button[aria-label="Send message"], button[data-testid="send-button"]',
    stopBtnSelector: 'button[aria-label="Stop Response"], button[aria-label="Stop response"]',
    codeSelector: 'pre code',
    limitKeywords: [
      'out of free messages',
      'message limit',
      'reset at',
      'subscribe to pro',
      'free tier limit'
    ]
  },
  'gemini.google.com': {
    name: 'Gemini',
    inputSelector: 'rich-textarea div.ql-editor[contenteditable="true"]',
    sendBtnSelector: 'button.send-button, button[aria-label="Send message"]',
    stopBtnSelector: 'button[aria-label="Stop response"]',
    codeSelector: 'code-block pre code, pre code',
    limitKeywords: [
      'reached your limit',
      'try again later',
      'limit reached'
    ]
  },
  'chat.deepseek.com': {
    name: 'DeepSeek',
    inputSelector: 'textarea#chat-input, textarea[placeholder*="DeepSeek"]',
    sendBtnSelector: 'div[role="button"][aria-label="Send"], button[aria-label="Send"]',
    stopBtnSelector: 'div[role="button"][aria-label="Stop"], button[aria-label="Stop"]',
    codeSelector: 'pre code',
    limitKeywords: [
      'server is busy',
      'rate limit',
      'too many requests'
    ]
  }
};

let currentHost = window.location.hostname;
let activeAdapter = null;

// Resolve adapter based on hostname
for (const [host, adapter] of Object.entries(DEFAULT_ADAPTERS)) {
  if (currentHost.includes(host)) {
    activeAdapter = adapter;
    break;
  }
}

if (!activeAdapter) {
  console.log('[aiDot ContentScript] Host not matched:', currentHost);
} else {
  console.log('[aiDot ContentScript] Initialized adapter for', activeAdapter.name);

  // Announce this tab to the service worker
  announceTab();
}

function announceTab() {
  if (!activeAdapter) return;
  chrome.runtime.sendMessage({
    type: 'REGISTER_TAB',
    provider: activeAdapter.name
  });
}

// Periodically re-announce tab in case service worker restarted
setInterval(() => {
  announceTab();
}, 20000);

/**
 * Check if the page is showing a rate-limit error or quota warning
 */
function checkRateLimit() {
  if (!activeAdapter) return false;
  const pageText = document.body.innerText.toLowerCase();
  return activeAdapter.limitKeywords.some((keyword) => pageText.includes(keyword.toLowerCase()));
}

/**
 * Safely inserts prompt into whatever contenteditable / textarea framework is in use
 */
async function injectPrompt(promptText) {
  const inputEl = document.querySelector(activeAdapter.inputSelector);
  if (!inputEl) {
    throw new Error(`Input element not found for ${activeAdapter.name} (selector: ${activeAdapter.inputSelector})`);
  }

  inputEl.focus();

  if (inputEl.tagName === 'TEXTAREA') {
    // For React / Vanilla textareas
    inputEl.value = promptText;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (inputEl.getAttribute('contenteditable') === 'true') {
    // For TipTap / ProseMirror / Quill
    // Try document.execCommand first for rich text framework friendliness
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    selection.removeAllRanges();
    selection.addRange(range);

    const success = document.execCommand('insertText', false, promptText);
    if (!success || !inputEl.innerText.trim()) {
      // Fallback direct HTML injection
      inputEl.innerHTML = `<p>${promptText.replace(/\n/g, '<br>')}</p>`;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('keyup', { bubbles: true }));
  }
}

/**
 * Handle incoming instructions from Service Worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'QUERY_PROVIDER') {
    sendResponse({ provider: activeAdapter ? activeAdapter.name : null });
    return true;
  }

  if (message.type === 'APPLY_SELECTORS' && message.selectors) {
    if (activeAdapter && message.selectors[activeAdapter.name]) {
      Object.assign(activeAdapter, message.selectors[activeAdapter.name]);
      console.log('[aiDot ContentScript] Updated selectors for', activeAdapter.name);
    }
    sendResponse({ status: 'ok' });
    return true;
  }

  if (message.type === 'EXECUTE_PROMPT') {
    handlePromptExecution(message.prompt, message.requestId, message.isArena);
    sendResponse({ status: 'started' });
    return true;
  }
});

async function handlePromptExecution(promptText, requestId, isArena) {
  // Pre-check for existing rate limit banner
  if (checkRateLimit()) {
    chrome.runtime.sendMessage({
      type: 'RATE_LIMIT_HIT',
      provider: activeAdapter.name,
      requestId,
      originalPrompt: promptText,
      reason: 'Rate limit detected prior to prompt execution'
    });
    return;
  }

  try {
    await injectPrompt(promptText);

    // Wait short delay for send button to become enabled
    setTimeout(() => {
      const sendBtn = document.querySelector(activeAdapter.sendBtnSelector);
      if (!sendBtn || sendBtn.disabled) {
        // If button is still disabled or missing, might be rate limited or blocked
        if (checkRateLimit()) {
          chrome.runtime.sendMessage({
            type: 'RATE_LIMIT_HIT',
            provider: activeAdapter.name,
            requestId,
            originalPrompt: promptText,
            reason: 'Send button disabled due to rate limit'
          });
          return;
        }

        // Try submitting via Enter key dispatch
        const inputEl = document.querySelector(activeAdapter.inputSelector);
        if (inputEl) {
          inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
      } else {
        sendBtn.click();
      }

      // Start watching response generation
      monitorResponseCompletion(promptText, requestId, isArena);
    }, 450);
  } catch (err) {
    console.error('[aiDot ContentScript] Failed to execute prompt:', err);
    chrome.runtime.sendMessage({
      type: 'RATE_LIMIT_HIT',
      provider: activeAdapter.name,
      requestId,
      originalPrompt: promptText,
      reason: err.message
    });
  }
}

/**
 * Monitors streaming completion via Stop Button disappearance + MutationObserver debounce
 */
function monitorResponseCompletion(promptText, requestId, isArena) {
  let finished = false;
  let lastMutationTime = Date.now();

  const observer = new MutationObserver(() => {
    lastMutationTime = Date.now();
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Initial wait for generation to spin up
  setTimeout(() => {
    const pollInterval = setInterval(() => {
      // Check mid-flight rate limit banner
      if (checkRateLimit()) {
        clearInterval(pollInterval);
        observer.disconnect();
        chrome.runtime.sendMessage({
          type: 'RATE_LIMIT_HIT',
          provider: activeAdapter.name,
          requestId,
          originalPrompt: promptText,
          reason: 'Mid-generation rate limit banner appeared'
        });
        return;
      }

      const stopBtn = document.querySelector(activeAdapter.stopBtnSelector);
      const isStillStreaming = !!stopBtn;
      const quietMs = Date.now() - lastMutationTime;

      // Finish condition: Stop button is gone AND no DOM changes occurred for 1.5 seconds
      if (!isStillStreaming && quietMs > 1500 && !finished) {
        finished = true;
        clearInterval(pollInterval);
        observer.disconnect();

        extractAndSendCode(requestId, isArena);
      }
    }, 800);
  }, 1800);
}

/**
 * Scrapes latest response text and code blocks from the DOM and sends back to VS Code
 */
function extractAndSendCode(requestId, isArena) {
  const codeBlocks = document.querySelectorAll(activeAdapter.codeSelector);
  let latestCode = '';
  
  if (codeBlocks.length > 0) {
    latestCode = codeBlocks[codeBlocks.length - 1].innerText;
  }

  // Also grab the raw text of the latest AI message turn
  let fullMessageText = '';
  const preElements = document.querySelectorAll('pre');
  if (preElements.length > 0) {
    const lastPre = preElements[preElements.length - 1];
    fullMessageText = lastPre.innerText;
  }

  const responseContent = latestCode || fullMessageText;

  chrome.runtime.sendMessage({
    type: 'CODE_RESPONSE',
    provider: activeAdapter.name,
    requestId,
    isArena: !!isArena,
    code: responseContent,
    rawText: document.body.innerText.slice(-2000)
  });
}
