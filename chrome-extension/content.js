/**
 * aiDot Chrome Extension - Content Script
 * Injected into chatgpt.com, claude.ai, gemini.google.com, chat.deepseek.com
 * Automates text injection, click submission, mutation tracking, rate-limit spotting, and code extraction.
 */

const DEFAULT_ADAPTERS = {
  'chatgpt.com': {
    name: 'ChatGPT',
    inputSelector: '#prompt-textarea, div[contenteditable="true"]#prompt-textarea, textarea#prompt-textarea, [data-placeholder="Ask anything"], div[contenteditable="true"]',
    sendBtnSelector: 'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]',
    stopBtnSelector: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]',
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
    inputSelector: 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"]',
    sendBtnSelector: 'button[aria-label="Send Message"], button[aria-label="Send message"], button[data-testid="send-button"], fieldset button[type="button"]',
    stopBtnSelector: 'button[aria-label="Stop Response"], button[aria-label="Stop response"], button[data-testid="stop-button"]',
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
    inputSelector: 'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"]',
    sendBtnSelector: 'button.send-button, button[aria-label*="Send message"], button[mattooltip="Send message"], .send-button-container button',
    stopBtnSelector: 'button[aria-label="Stop response"], button.stop-button, button[aria-label*="Stop"], mat-icon[fonticon="stop"]',
    codeSelector: 'code-block pre code, pre code',
    limitKeywords: [
      'reached your limit',
      'try again later',
      'limit reached'
    ]
  },
  'chat.deepseek.com': {
    name: 'DeepSeek',
    inputSelector: 'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea',
    sendBtnSelector: 'div[role="button"][aria-label="Send"], button[aria-label="Send"], button#chat-send-btn',
    stopBtnSelector: 'div[role="button"][aria-label="Stop"], button[aria-label="Stop"]',
    codeSelector: 'pre code',
    limitKeywords: [
      'server is busy',
      'rate limit',
      'too many requests'
    ]
  }
};

let currentHost = window.location.hostname.toLowerCase();
let activeAdapter = null;

// Resolve adapter based on hostname
for (const [host, adapter] of Object.entries(DEFAULT_ADAPTERS)) {
  if (currentHost.includes(host.toLowerCase())) {
    activeAdapter = adapter;
    break;
  }
}

if (!activeAdapter) {
  console.log('[AiDot ContentScript] Host not matched:', currentHost);
} else {
  console.log('[AiDot ContentScript] Initialized adapter for', activeAdapter.name);
  announceTab();
}

function announceTab() {
  if (!activeAdapter) return;
  chrome.runtime.sendMessage({
    type: 'REGISTER_TAB',
    provider: activeAdapter.name
  }, () => {
    chrome.runtime.lastError;
  });
}

setInterval(() => {
  announceTab();
}, 8000);

function checkRateLimit() {
  if (!activeAdapter) return false;
  const pageText = document.body.innerText.toLowerCase();
  return activeAdapter.limitKeywords.some((keyword) => pageText.includes(keyword.toLowerCase()));
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Strips echoed prompt preambles and instructions from model outputs
 */
function stripPromptEcho(text) {
  if (!text) return '';
  let cleaned = text.trim();

  // If the text starts with the AiDot prompt preamble
  if (cleaned.startsWith('You are AiDot') || cleaned.startsWith('Workspace root:')) {
    // 1. Check if <run_command ... /> exists
    const runCmdIdx = cleaned.lastIndexOf('<run_command');
    if (runCmdIdx !== -1) {
      const endTag = cleaned.indexOf('>', runCmdIdx);
      if (endTag !== -1) {
        const after = cleaned.substring(endTag + 1).trim();
        if (after) return after;
      }
    }

    // 2. Check if >>>>>>> REPLACE exists
    const replaceIdx = cleaned.lastIndexOf('>>>>>>> REPLACE');
    if (replaceIdx !== -1) {
      const codeEnd = cleaned.indexOf('```', replaceIdx);
      if (codeEnd !== -1) {
        const after = cleaned.substring(codeEnd + 3).trim();
        if (after) return after;
      }
    }

    // 3. Check for INSTRUCTIONS:
    const instIdx = cleaned.lastIndexOf('INSTRUCTIONS:');
    if (instIdx !== -1) {
      const after = cleaned.substring(instIdx);
      const lines = after.split('\n');
      let foundStart = false;
      let answerLines = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!foundStart) {
          if (l.includes('<run_command') || l.includes('command to run') || l.includes('>>>>>>> REPLACE') || (l.startsWith('3.') && l.length > 20)) {
            foundStart = true;
          }
        } else {
          if (l && !l.startsWith('```') && !l.startsWith('<')) {
            answerLines = lines.slice(i);
            break;
          }
        }
      }
      if (answerLines.length > 0) {
        const ans = answerLines.join('\n').trim();
        if (ans) return ans;
      }
    }

    // 4. Fallback: split by multiple blank lines
    const blocks = cleaned.split(/\n\s*\n\s*\n+/);
    if (blocks.length > 1) {
      for (let i = 1; i < blocks.length; i++) {
        const b = blocks[i].trim();
        if (b && !b.includes('You are AiDot') && !b.includes('Workspace root:') && !b.includes('INSTRUCTIONS:')) {
          return blocks.slice(i).join('\n\n').trim();
        }
      }
    }
  }

  // If text starts with "User Prompt: ... \n\n"
  if (cleaned.startsWith('User Prompt:')) {
    const end = cleaned.indexOf('\n\n');
    if (end !== -1) {
      cleaned = cleaned.substring(end + 2).trim();
    }
  }

  return cleaned;
}

/**
 * Robust input injection supporting React 18, ProseMirror, Quill, and Textareas
 */
async function injectPrompt(promptText) {
  let inputEl = document.querySelector(activeAdapter.inputSelector);
  
  if (!inputEl) {
    inputEl = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
  }

  if (!inputEl) {
    throw new Error(`Input element not found for ${activeAdapter.name}`);
  }

  inputEl.focus();

  if (inputEl.tagName === 'TEXTAREA') {
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(inputEl, promptText);
    } else {
      inputEl.value = promptText;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }

  // Contenteditable (ChatGPT, Claude, Gemini)
  let targetChild = inputEl.querySelector('p') || inputEl;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(targetChild);
  selection.removeAllRanges();
  selection.addRange(range);

  // Method 1: Synthesize paste event with defined clipboardData (ProseMirror native path)
  const pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(pasteEvent, 'clipboardData', {
    value: {
      getData: (type) => {
        if (type === 'text/plain' || type === 'text' || !type) return promptText;
        return '';
      },
      types: ['text/plain']
    }
  });
  inputEl.dispatchEvent(pasteEvent);

  // Method 2: If paste did not update text in DOM, try beforeinput insertFromPaste
  if (!inputEl.innerText.trim()) {
    const beforeInputEv = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: 'insertFromPaste'
    });
    Object.defineProperty(beforeInputEv, 'dataTransfer', {
      value: {
        getData: (type) => promptText,
        types: ['text/plain']
      }
    });
    inputEl.dispatchEvent(beforeInputEv);
  }

  // Method 3: Fallback via document.execCommand('insertText')
  if (!inputEl.innerText.trim()) {
    try {
      document.execCommand('insertText', false, promptText);
    } catch (e) {}
  }

  // Method 4: Direct paragraph assignment fallback
  if (!inputEl.innerText.trim()) {
    targetChild.textContent = promptText;
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: promptText }));
  }

  // Notify frameworks
  inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
}

/**
 * Finds the Send button for Claude with comprehensive fallbacks
 */
function getClaudeSendButton() {
  const selectors = [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send Prompt"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[data-testid="send-button"]',
    'fieldset button[type="button"]',
    'fieldset button',
    'form button[type="submit"]',
    'div:has(> div.ProseMirror) ~ div button'
  ];
  for (const s of selectors) {
    try {
      const el = document.querySelector(s);
      if (el) return el;
    } catch (e) {}
  }
  const container = document.querySelector('div.ProseMirror')?.closest('fieldset, form, div[class*="relative"], main');
  if (container) {
    const btns = Array.from(container.querySelectorAll('button'));
    const sendCandidate = btns.filter(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      return !label.includes('attach') && !label.includes('upload') && !label.includes('style') && !label.includes('model');
    });
    if (sendCandidate.length > 0) {
      return sendCandidate[sendCandidate.length - 1];
    }
  }
  return null;
}

/**
 * Finds the Send button for ChatGPT with comprehensive fallbacks
 */
function getChatGPTSendButton() {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    'form button[type="submit"]',
    '#prompt-textarea-wrapper button',
    'fieldset button[data-testid*="send"]'
  ];
  for (const sel of selectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    } catch (e) {}
  }
  const promptContainer = document.querySelector('#prompt-textarea')?.closest('form, fieldset, div[class*="relative"]');
  if (promptContainer) {
    const buttons = promptContainer.querySelectorAll('button');
    for (const b of buttons) {
      if (b.querySelector('svg') && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        return b;
      }
    }
  }
  return null;
}

/**
 * Finds the Send button across providers
 */
function getSendButton() {
  if (activeAdapter.name === 'Claude') {
    return getClaudeSendButton();
  }
  if (activeAdapter.name === 'ChatGPT') {
    return getChatGPTSendButton();
  }

  let btn = document.querySelector(activeAdapter.sendBtnSelector);
  if (!btn) {
    btn = document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[aria-label*="Send"]') ||
          document.querySelector('button[aria-label*="send"]') ||
          document.querySelector('button.send-button');
  }
  return btn;
}

/**
 * Finds the Stop button across providers with strict targeting to avoid false positives
 */
function getStopButton() {
  if (activeAdapter.name === 'ChatGPT') {
    const stopSel = [
      'button[data-testid="stop-button"]',
      'button[data-testid="fruitjuice-stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop response"]',
      '#prompt-textarea-wrapper button[aria-label*="Stop"]',
      'form button[data-testid*="stop"]',
      'form button[aria-label="Stop"]'
    ];
    for (const sel of stopSel) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  const selectors = [
    activeAdapter?.stopBtnSelector,
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop streaming"]',
    'button.stop-button',
    'div[role="button"][aria-label="Stop"]'
  ];
  for (const s of selectors) {
    if (!s) continue;
    try {
      const el = document.querySelector(s);
      if (el) return el;
    } catch (e) {}
  }
  return null;
}

/**
 * Submits the injected prompt by waiting for the send button to become enabled, or falling back to Enter
 */
async function submitPrompt() {
  const startTime = Date.now();
  let clicked = false;

  await new Promise(r => setTimeout(r, 200));

  while (Date.now() - startTime < 3500) {
    const sendBtn = getSendButton();
    if (sendBtn) {
      const isDisabled = sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
      if (!isDisabled) {
        sendBtn.click();
        clicked = true;
        console.log('[AiDot ContentScript] Clicked enabled send button for', activeAdapter.name);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 120));
  }

  if (!clicked) {
    const sendBtn = getSendButton();
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.removeAttribute('disabled');
      sendBtn.removeAttribute('aria-disabled');
      sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
      sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
      sendBtn.click();
      clicked = true;
      console.log('[AiDot ContentScript] Force-clicked send button for', activeAdapter.name);
    }
  }

  const inputEl = document.querySelector(activeAdapter.inputSelector) ||
                  document.querySelector('div[contenteditable="true"]') ||
                  document.querySelector('textarea');
  if (inputEl) {
    inputEl.focus();
    const enterOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: false
    };
    inputEl.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
    console.log('[AiDot ContentScript] Dispatched Enter key for', activeAdapter.name);
  }

  return clicked;
}

/**
 * Retrieves ChatGPT assistant response elements.
 * Strictly prioritizes [data-message-author-role="assistant"] turns.
 */
function getChatGPTAssistantElements() {
  // 1. Elements explicitly tagged with author role assistant (canonical ChatGPT turn attribute)
  const assistantRoles = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  if (assistantRoles.length > 0) {
    return assistantRoles;
  }

  // 2. Articles / conversation turns without user role
  const articles = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"], article'))
    .filter(a => !a.querySelector('[data-message-author-role="user"]'));
  if (articles.length > 0) {
    return articles;
  }

  // 3. Fallback to markdown/prose elements not inside a user turn or composer
  const markdowns = Array.from(document.querySelectorAll('div.markdown, div[class*="markdown"], div.prose, div[class*="prose"]'))
    .filter(m => !m.closest('[data-message-author-role="user"]') && !m.closest('form') && !m.closest('#prompt-textarea-wrapper'));

  return markdowns;
}

/**
 * Retrieves TOP-LEVEL assistant response elements currently in the DOM.
 */
function getAssistantElements() {
  let allMatches = [];

  if (activeAdapter.name === 'Claude') {
    allMatches = Array.from(document.querySelectorAll(
      '[data-message-author-role="assistant"], div[data-is-streaming], div[data-testid="chat-message-assistant"], .font-claude-message'
    )).filter(el => {
      return !el.closest('[data-message-author-role="user"]') &&
             !el.closest('form') &&
             !el.closest('fieldset');
    });
  } else if (activeAdapter.name === 'ChatGPT') {
    return getChatGPTAssistantElements();
  } else if (activeAdapter.name === 'Gemini') {
    allMatches = Array.from(document.querySelectorAll(
      'model-response, message-content, .model-response-text'
    ));
  } else if (activeAdapter.name === 'DeepSeek') {
    allMatches = Array.from(document.querySelectorAll(
      '.chat-message-assistant, .ds-markdown'
    ));
  } else {
    allMatches = Array.from(document.querySelectorAll(
      '[data-message-author-role="assistant"], .font-claude-message, .ds-markdown, message-content'
    ));
  }

  const topLevel = allMatches.filter(el => {
    return !allMatches.some(other => other !== el && other.contains(el));
  });

  return topLevel;
}

/**
 * Extracts pure text from the latest assistant element, stripped of any echoed prompt
 */
function getLatestAssistantText(assistantEl) {
  if (!assistantEl) return '';

  let raw = '';
  if (activeAdapter.name === 'ChatGPT') {
    // 1. Check for inner rendered prose/markdown container
    const contentEl = assistantEl.querySelector('div.markdown, div[class*="markdown"], div.prose, div[class*="prose"], div.text-message');
    if (contentEl) {
      raw = (contentEl.innerText || contentEl.textContent || '').trim();
    }
    // 2. If contentEl is missing or empty, take assistantEl's full text
    if (!raw) {
      raw = (assistantEl.innerText || assistantEl.textContent || '').trim();
    }
    // 3. Fallback to paragraph extraction
    if (!raw) {
      const ps = Array.from(assistantEl.querySelectorAll('p')).map(p => p.innerText.trim()).filter(Boolean);
      if (ps.length > 0) {
        raw = ps.join('\n\n');
      }
    }
    return stripPromptEcho(raw);
  }

  if (activeAdapter.name === 'Claude') {
    raw = assistantEl.innerText || assistantEl.textContent || '';
    return stripPromptEcho(raw);
  }

  if (activeAdapter.name === 'Gemini') {
    const msg = assistantEl.querySelector('message-content, .model-response-text, .markdown');
    raw = msg ? (msg.innerText || msg.textContent || '') : (assistantEl.innerText || assistantEl.textContent || '');
    return stripPromptEcho(raw);
  }

  if (activeAdapter.name === 'DeepSeek') {
    const md = assistantEl.querySelector('.ds-markdown');
    raw = md ? (md.innerText || md.textContent || '') : (assistantEl.innerText || assistantEl.textContent || '');
    return stripPromptEcho(raw);
  }

  raw = assistantEl.innerText || assistantEl.textContent || '';
  return stripPromptEcho(raw);
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
      console.log('[AiDot ContentScript] Updated selectors for', activeAdapter.name);
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
    // Record baseline state before prompt injection
    const initialElements = getAssistantElements();
    const initialCount = initialElements.length;
    const initialText = initialElements.length > 0 ? getLatestAssistantText(initialElements[initialElements.length - 1]) : '';

    await injectPrompt(promptText);
    await submitPrompt();

    // Monitor generation lifecycle
    monitorResponseCompletion(promptText, requestId, isArena, initialCount, initialText);
  } catch (err) {
    console.error('[AiDot ContentScript] Failed to execute prompt:', err);
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
 * Monitors streaming completion using responsive state tracking + text stability
 */
function monitorResponseCompletion(promptText, requestId, isArena, initialCount, initialText) {
  let finished = false;
  let generationStarted = false;
  const monitorStartTime = Date.now();

  let lastPolledText = '';
  let stableTextCount = 0;

  const pollInterval = setInterval(() => {
    // 1. Check mid-flight rate limit
    if (checkRateLimit()) {
      clearInterval(pollInterval);
      chrome.runtime.sendMessage({
        type: 'RATE_LIMIT_HIT',
        provider: activeAdapter.name,
        requestId,
        originalPrompt: promptText,
        reason: 'Mid-generation rate limit banner appeared'
      });
      return;
    }

    const currentElements = getAssistantElements();
    const latestEl = currentElements.length > 0 ? currentElements[currentElements.length - 1] : null;
    const latestText = latestEl ? getLatestAssistantText(latestEl) : '';

    const stopBtn = getStopButton();
    const isStreamingAttr = (activeAdapter.name === 'Claude' && !!document.querySelector('[data-is-streaming="true"]')) ||
                            (latestEl ? (latestEl.classList?.contains('result-streaming') || !!latestEl.querySelector?.('.result-streaming, [data-is-streaming="true"]')) : false);
    const isCurrentlyGenerating = !!stopBtn || isStreamingAttr;

    // Detect when generation has officially started
    if (!generationStarted) {
      const hasNewMessage = currentElements.length > initialCount;
      const textChanged = latestText && latestText !== initialText && latestText.length > 5;
      if (isCurrentlyGenerating || hasNewMessage || textChanged) {
        generationStarted = true;
        console.log(`[AiDot ContentScript] Generation started for ${activeAdapter.name}`);
      } else if (Date.now() - monitorStartTime > 6000) {
        generationStarted = true;
      }
    }

    // When generation has started, track completion via text stability and absence of stop button
    if (generationStarted && !finished) {
      const hasContent = latestText.length > 15 && latestText !== initialText;

      if (!isCurrentlyGenerating && hasContent) {
        if (latestText === lastPolledText) {
          stableTextCount++;
        } else {
          lastPolledText = latestText;
          stableTextCount = 1;
        }
      } else {
        lastPolledText = latestText;
        stableTextCount = 0;
      }

      // Settled condition: Stop button is gone AND text has remained stable for >= 2 consecutive ticks (800ms)
      const isTextSettled = stableTextCount >= 2;
      const timedOut = (Date.now() - monitorStartTime) > 45000;

      if ((!isCurrentlyGenerating && isTextSettled && hasContent) || timedOut) {
        finished = true;
        clearInterval(pollInterval);
        console.log(`[AiDot ContentScript] Generation settled for ${activeAdapter.name}`);
        extractAndSendCode(promptText, requestId, isArena);
      }
    }
  }, 400);
}

/**
 * Scrapes latest response text and surgical diffs from the DOM
 */
function extractAndSendCode(promptText, requestId, isArena) {
  const assistantElements = getAssistantElements();
  const latestAssistantEl = assistantElements.length > 0 ? assistantElements[assistantElements.length - 1] : null;

  let rawAssistantText = getLatestAssistantText(latestAssistantEl);
  let latestCode = '';

  // Extract surgical diffs (all blocks present across code blocks or full response text)
  if (latestAssistantEl) {
    const codeBlocks = latestAssistantEl.querySelectorAll('pre code, code');
    const matchedBlocks = [];
    for (let i = 0; i < codeBlocks.length; i++) {
      const code = (codeBlocks[i].innerText || codeBlocks[i].textContent || '');
      if (
        code.includes('<<<<<<< SEARCH') &&
        code.includes('>>>>>>> REPLACE') &&
        !code.includes('exact lines to find in original file')
      ) {
        matchedBlocks.push(code);
      }
    }
    if (matchedBlocks.length > 0) {
      latestCode = matchedBlocks.join('\n\n');
    }
  }

  // If no individual code block had both markers, but the overall assistant text has diff blocks, use full text
  if (!latestCode && rawAssistantText.includes('<<<<<<< SEARCH') && rawAssistantText.includes('>>>>>>> REPLACE')) {
    latestCode = rawAssistantText;
  }

  let cleanedText = rawAssistantText || latestCode;
  if (!cleanedText || cleanedText.trim() === '') {
    const fallbackEl = document.querySelector('[data-message-author-role="assistant"] div.markdown, [data-message-author-role="assistant"] div.prose, [data-message-author-role="assistant"]');
    if (fallbackEl) {
      cleanedText = stripPromptEcho((fallbackEl.innerText || fallbackEl.textContent || '').trim());
    }
  }
  if (!cleanedText) {
    cleanedText = 'Response completed.';
  }

  console.log(`[AiDot ContentScript] Extracted response for ${activeAdapter.name}:`, cleanedText.slice(0, 100));

  chrome.runtime.sendMessage({
    type: 'CODE_RESPONSE',
    provider: activeAdapter.name,
    requestId,
    isArena: !!isArena,
    code: latestCode || cleanedText,
    fullText: cleanedText,
    rawText: cleanedText
  });
}
