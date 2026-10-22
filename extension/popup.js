/**
 * popup.js
 * ────────
 * Responsibility : Manage all UI logic for the popup window.
 *
 * This script:
 *  1. Initialises the UI when the popup opens.
 *  2. Extracts page content by injecting content.js into the active tab.
 *  3. Sends chat requests to background.js (which relays to the backend).
 *  4. Renders responses safely using marked.js + a simple HTML sanitiser.
 *  5. Persists conversation history per-tab using chrome.storage.local.
 *  6. Handles all error states with readable messages.
 *
 * ── Key design decisions ──────────────────────────────────────────────────────
 *
 * Why does the popup talk to background.js instead of fetching directly?
 *   The popup could fetch the backend directly, but routing through
 *   background.js keeps network logic in one place and avoids CORS
 *   configuration headaches that arise from the popup's unique origin.
 *
 * Why chrome.storage.local for history?
 *   Popups are destroyed when closed.  localStorage is not available in
 *   extension popups.  chrome.storage.local persists across popup opens
 *   and is per-profile, not shared across machines.
 *
 * Why is history bounded?
 *   LLMs have context limits.  Sending unlimited history wastes tokens,
 *   slows responses, and risks hitting request-size limits.
 *
 * ── Security ──────────────────────────────────────────────────────────────────
 *
 * Sanitisation:
 *   marked.parse() converts Markdown to HTML.  We run that HTML through
 *   sanitiseHtml() before inserting it with innerHTML.  This strips
 *   <script> tags, on* event handlers, and javascript: hrefs.
 *
 *   This is a simple allowlist approach.  For a production tool you would
 *   use a hardened library like DOMPurify (not included here to keep
 *   the extension dependency-free).
 *
 * Untrusted content:
 *   We treat page text and LLM responses as untrusted.  User messages are
 *   inserted with textContent (not innerHTML) — no HTML injection possible.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_HISTORY_PAIRS = 10; // Keep last N user+assistant pairs in local storage
const STORAGE_KEY_PREFIX = 'tab_';

// ── DOM references ─────────────────────────────────────────────────────────────
const chatContainer   = document.getElementById('chat-container');
const emptyState      = document.getElementById('empty-state');
const userInput       = document.getElementById('user-input');
const sendBtn         = document.getElementById('send-btn');
const analyzeBtn      = document.getElementById('analyze-btn');
const refreshBtn      = document.getElementById('refresh-btn');
const clearBtn        = document.getElementById('clear-btn');
const copyBtn         = document.getElementById('copy-btn');
const pageHostname    = document.getElementById('page-hostname');
const pageTitleText   = document.getElementById('page-title-text');
const pageStatus      = document.getElementById('page-status');
const connectionDot   = document.getElementById('connection-dot');

// Settings DOM references (BYOK)
const settingsOpenBtn   = document.getElementById('settings-open-btn');
const settingsCloseBtn  = document.getElementById('settings-close-btn');
const settingsModal     = document.getElementById('settings-modal');
const settingsApiKey    = document.getElementById('settings-api-key');
const settingsModel     = document.getElementById('settings-model');
const settingsSaveBtn   = document.getElementById('settings-save-btn');
const settingsStatusMsg = document.getElementById('settings-status-msg');
const authEmail         = document.getElementById('auth-email');
const authPassword      = document.getElementById('auth-password');
const authStatusMsg     = document.getElementById('auth-status-msg');
const authSignInBtn     = document.getElementById('auth-sign-in-btn');
const authSignUpBtn     = document.getElementById('auth-sign-up-btn');
const authSignOutBtn    = document.getElementById('auth-sign-out-btn');

// ── State ──────────────────────────────────────────────────────────────────────
let currentTab        = null;   // { tabId, url, title }
let pageContext       = null;   // Extracted text from the current page
let conversationId    = null;   // Server-side conversation UUID
let isLoading         = false;
let userApiKey        = null;   // User's personal Groq API key (BYOK)
let userSession       = null;   // Neon Auth session token, scoped to this browser profile
let userModel         = 'openai/gpt-oss-20b';

// ── Initialisation ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 1. Get the active tab info.
  const tabResult = await sendMessage({ type: 'GET_TAB_INFO' });
  if (tabResult.ok) {
    currentTab = tabResult.data;
    updatePageBar(currentTab.url, currentTab.title);
  } else {
    setPageStatus('Could not read tab info.', 'error');
  }

  // 2. Load credentials before making backend requests.
  await loadUserSettings();

  // 3. Check backend connectivity.
  checkBackendHealth();

  // 4. Load saved state for this tab (conversation history, pageContext, etc.).
  await loadTabState();

  // 5. Wire up event listeners.
  sendBtn.addEventListener('click', handleSend);
  analyzeBtn.addEventListener('click', () => analyzePage(false));
  refreshBtn.addEventListener('click', () => analyzePage(true));
  clearBtn.addEventListener('click', handleClear);
  copyBtn.addEventListener('click', handleCopy);

  // Settings modal controls
  settingsOpenBtn.addEventListener('click', openSettingsModal);
  settingsCloseBtn.addEventListener('click', closeSettingsModal);
  settingsSaveBtn.addEventListener('click', saveUserSettings);
  authSignInBtn.addEventListener('click', () => authenticate('AUTH_SIGN_IN'));
  authSignUpBtn.addEventListener('click', () => authenticate('AUTH_SIGN_UP'));
  authSignOutBtn.addEventListener('click', signOut);

  // Suggestion chips.
  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      userInput.value = chip.dataset.prompt;
      handleSend();
    });
  });

  // Enter = send, Shift+Enter = new line.
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
}

// ── User Settings (BYOK) ───────────────────────────────────────────────────────
async function loadUserSettings() {
  try {
    const localData = await chrome.storage.local.get(['groqApiKey', 'groqModel', 'userSession']);
    let data = localData;
    // Move previously synced credentials off Google's sync service and keep
    // the BYOK key and backend token local to this browser profile.
    if ((!data.groqApiKey || !data.groqModel) && chrome.storage.sync) {
      const syncedData = await chrome.storage.sync.get(['groqApiKey', 'groqModel']);
      data = { ...syncedData, ...data };
      if (syncedData.groqApiKey || syncedData.groqModel) {
        await chrome.storage.local.set({
          ...(data.groqApiKey ? { groqApiKey: data.groqApiKey } : {}),
          ...(data.groqModel ? { groqModel: data.groqModel } : {}),
        });
        await chrome.storage.sync.remove(['groqApiKey', 'groqModel']);
      }
    }
    userApiKey = data.groqApiKey || null;
    userSession = localData.userSession || null;
    await chrome.storage.local.remove('backendApiToken');
    updateAuthControls();
    if (!localData.authConfig) sendMessage({ type: 'AUTH_CONFIG' });
    // Replace model IDs saved by older versions of the extension.
    const savedModel = data.groqModel;
    userModel = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(savedModel)
      ? savedModel
      : 'openai/gpt-oss-20b';

    if (userApiKey) {
      settingsOpenBtn.title = `Settings · Personal API key active (${userModel})`;
    } else {
      settingsOpenBtn.title = 'Settings · No personal key set (click to configure)';
    }
  } catch (err) {
    console.warn('Could not load user settings:', err);
  }
}

function openSettingsModal() {
  settingsApiKey.value = userApiKey || '';
  settingsModel.value = userModel || 'openai/gpt-oss-20b';
  settingsStatusMsg.textContent = '';
  settingsStatusMsg.className = 'settings-status';
  settingsModal.style.display = 'flex';
  if (userSession?.access_token) settingsApiKey.focus();
  else authEmail.focus();
}

function closeSettingsModal() {
  settingsModal.style.display = 'none';
}

async function saveUserSettings() {
  const key = settingsApiKey.value.trim();
  const model = settingsModel.value;

  try {
    await Promise.all([
      chrome.storage.local.set({ groqApiKey: key, groqModel: model }),
      chrome.storage.sync?.remove(['groqApiKey', 'groqModel']),
    ]);
    userApiKey = key || null;
    userModel = model;

    settingsStatusMsg.textContent = '✓ Saved successfully!';
    settingsStatusMsg.className = 'settings-status success';
    checkBackendHealth();

    if (userApiKey) {
      settingsOpenBtn.title = `Settings · Personal API key active (${userModel})`;
    } else {
      settingsOpenBtn.title = 'Settings · Server default key active';
    }

    setTimeout(() => {
      closeSettingsModal();
    }, 700);
  } catch (err) {
    settingsStatusMsg.textContent = `Error: ${err.message}`;
    settingsStatusMsg.className = 'settings-status error';
  }
}

async function authenticate(type) {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    authStatusMsg.textContent = 'Enter your email and password.';
    authStatusMsg.className = 'settings-status error';
    return;
  }
  const result = await sendMessage({ type, payload: { email, password } });
  if (!result.ok) {
    authStatusMsg.textContent = result.error;
    authStatusMsg.className = 'settings-status error';
    return;
  }
  if (!result.data?.access_token) {
    authStatusMsg.textContent = 'Account created. Check your email to confirm, then sign in.';
    authStatusMsg.className = 'settings-status success';
    return;
  }
  userSession = result.data;
  updateAuthControls();
  authPassword.value = '';
  authStatusMsg.textContent = 'Signed in.';
  authStatusMsg.className = 'settings-status success';
  checkBackendHealth();
}

async function signOut() {
  await sendMessage({ type: 'AUTH_SIGN_OUT' });
  userSession = null;
  window.location.reload();
}

function updateAuthControls() {
  const signedIn = Boolean(userSession?.access_token);
  authSignInBtn.hidden = signedIn;
  authSignUpBtn.hidden = signedIn;
  authSignOutBtn.hidden = !signedIn;
  authEmail.disabled = signedIn;
  authPassword.disabled = signedIn;
  if (signedIn && !authStatusMsg.textContent) authStatusMsg.textContent = 'Signed in.';
}

// ── Backend health check ───────────────────────────────────────────────────────
async function checkBackendHealth() {
  connectionDot.className = 'connection-dot'; // neutral yellow
  const result = await sendMessage({ type: 'HEALTH_CHECK' });
  if (result.ok) {
    connectionDot.className = 'connection-dot online';
    connectionDot.title = `Backend online · model: ${result.data?.model || 'unknown'}`;
  } else {
    connectionDot.className = 'connection-dot offline';
    connectionDot.title = result.error || 'Backend offline';
  }
}

// ── Tab state (chrome.storage.local) ──────────────────────────────────────────
function storageKey() {
  const accountId = userSession?.user?.id || 'signed-out';
  return currentTab ? `${accountId}_${STORAGE_KEY_PREFIX}${currentTab.tabId}` : null;
}

async function loadTabState() {
  const key = storageKey();
  if (!key) return;

  const stored = await chrome.storage.local.get(key);
  const state = stored[key];

  if (!state) return;

  // If the stored URL doesn't match the current tab URL, the user navigated.
  // Prompt them to re-analyze instead of silently using stale context.
  if (state.pageUrl && currentTab && state.pageUrl !== currentTab.url) {
    setPageStatus('Page changed — click Analyze Page', 'error');
    pageContext = null;
    conversationId = null;
    return;
  }

  // Restore state.
  pageContext     = state.pageContext || null;
  conversationId  = state.conversationId || null;

  if (state.pageContext) {
    setPageStatus(`Ready · ${state.charCount || '?'} chars extracted`, 'ready');
    analyzeBtn.textContent = 'Re-analyze';
  }

  // Restore conversation history.
  if (state.history && state.history.length > 0) {
    hideEmptyState();
    state.history.forEach(({ role, content }) => {
      if (role === 'user') appendUserMessage(content);
      else appendAssistantMessage(content);
    });
    scrollToBottom();
  }
}

async function saveTabState(history) {
  const key = storageKey();
  if (!key) return;

  // Keep only the last MAX_HISTORY_PAIRS pairs.
  const bounded = history.slice(-(MAX_HISTORY_PAIRS * 2));

  await chrome.storage.local.set({
    [key]: {
      pageUrl:       currentTab?.url,
      pageContext,
      charCount:     pageContext?.length,
      conversationId,
      history:       bounded,
    },
  });
}

async function clearTabState() {
  const key = storageKey();
  if (!key) return;
  await chrome.storage.local.remove(key);
}

// ── Page analysis ──────────────────────────────────────────────────────────────
/**
 * Inject content.js into the active tab, extract text, and save state.
 * @param {boolean} force  – if true, re-extract even if already done
 */
async function analyzePage(force = false) {
  if (!currentTab) {
    setPageStatus('No tab found.', 'error');
    return;
  }

  // Check for restricted URLs that cannot be scripted.
  const { url } = currentTab;
  if (isRestrictedUrl(url)) {
    setPageStatus('Cannot analyze browser pages (chrome://, etc.)', 'error');
    return;
  }

  if (pageContext && !force) return; // Already extracted.

  setPageStatus('Analyzing…', 'loading');
  analyzeBtn.disabled = true;
  refreshBtn.disabled = true;

  try {
    // executeScript injects content.js and returns the IIFE's return value.
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.tabId },
      files: ['content.js'],
    });

    const result = results?.[0]?.result;
    if (!result || !result.text) {
      throw new Error('No text could be extracted from this page.');
    }

    pageContext = result.text;
    setPageStatus(`Ready · ${result.characterCount.toLocaleString()} chars`, 'ready');
    analyzeBtn.textContent = 'Re-analyze';

    // Save immediately so the context survives popup close/reopen.
    await saveTabState(getStoredHistory());

  } catch (err) {
    if (err.message.includes('Cannot access') || err.message.includes('chrome://')) {
      setPageStatus('Cannot access this page type.', 'error');
    } else {
      setPageStatus(`Extraction failed: ${err.message}`, 'error');
    }
    pageContext = null;
  } finally {
    analyzeBtn.disabled = false;
    refreshBtn.disabled = false;
  }
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('moz-extension://')
  );
}

// ── Sending messages ───────────────────────────────────────────────────────────
async function handleSend() {
  const question = userInput.value.trim();
  if (!question || isLoading) return;

  // If the page hasn't been analyzed yet, try automatically first.
  if (!pageContext && currentTab && !isRestrictedUrl(currentTab.url)) {
    await analyzePage(false);
    // If extraction failed, we still allow the question (general knowledge mode).
  }

  userInput.value = '';
  setLoadingState(true);
  hideEmptyState();

  // Show user message immediately.
  appendUserMessage(question);

  // Local history is only for rendering the popup; the API uses its database copy.
  const history = getStoredHistory();

  // Build the chat request payload.
  const payload = {
    question,
    pageContext: pageContext || undefined,
    pageUrl:    currentTab?.url,
    pageTitle:  currentTab?.title,
    conversationId: conversationId || undefined,
    // BYOK: include user's personal key & model if configured
    apiKey: userApiKey || undefined,
    model: userModel || undefined,
  };

  // Show a loading indicator while waiting.
  const loadingEl = appendLoadingIndicator();

  try {
    const result = await sendMessage({ type: 'CHAT', payload });

    loadingEl.remove();

    if (result.ok) {
      const { answer, conversationId: newConvId } = result.data;

      // Save the server-assigned conversationId so future messages continue it.
      conversationId = newConvId;

      appendAssistantMessage(answer);

      // Persist the updated history.
      const updatedHistory = [
        ...history,
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ];
      await saveTabState(updatedHistory);

    } else {
      appendErrorMessage(result.error || 'An unknown error occurred.');
    }

  } catch (err) {
    loadingEl.remove();
    appendErrorMessage(`Unexpected error: ${err.message}`);
  } finally {
    setLoadingState(false);
    scrollToBottom();
  }
}

// ── History helpers ────────────────────────────────────────────────────────────
/**
 * Read the current history array from DOM storage (synchronously from state).
 * We collect it from the existing message elements so we don't need a
 * separate in-memory array.
 */
function getStoredHistory() {
  const rows = chatContainer.querySelectorAll('.message-row');
  const history = [];
  rows.forEach((row) => {
    const msgEl = row.querySelector('.message');
    if (!msgEl) return;
    if (msgEl.classList.contains('user')) {
      history.push({ role: 'user', content: msgEl.dataset.rawText || msgEl.textContent });
    } else if (msgEl.classList.contains('assistant')) {
      history.push({ role: 'assistant', content: msgEl.dataset.rawText || msgEl.textContent });
    }
  });
  return history;
}

// ── UI rendering helpers ───────────────────────────────────────────────────────
function appendUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row';
  row.innerHTML = `<div class="message-label" style="text-align:right">You</div>`;

  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.style.alignSelf = 'flex-end';
  // textContent is safe — no HTML injection from user input.
  msg.textContent = text;
  msg.dataset.rawText = text;

  row.appendChild(msg);
  chatContainer.appendChild(row);
  scrollToBottom();
}

function appendAssistantMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row';

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'Smart Assistant';
  row.appendChild(label);

  const msg = document.createElement('div');
  msg.className = 'message assistant';
  // Render Markdown then sanitise the resulting HTML before inserting.
  msg.innerHTML = sanitiseHtml(marked.parse(text));
  msg.dataset.rawText = text;
  row.appendChild(msg);

  // Copy button for this specific message.
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copyMsgBtn = document.createElement('button');
  copyMsgBtn.className = 'action-btn';
  copyMsgBtn.textContent = '📋 Copy';
  copyMsgBtn.addEventListener('click', () => copyToClipboard(text, copyMsgBtn));
  actions.appendChild(copyMsgBtn);
  row.appendChild(actions);

  chatContainer.appendChild(row);
  scrollToBottom();
}

function appendErrorMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row';

  const msg = document.createElement('div');
  msg.className = 'message error';
  msg.textContent = `⚠ ${text}`;
  row.appendChild(msg);

  chatContainer.appendChild(row);
}

function appendLoadingIndicator() {
  const el = document.createElement('div');
  el.className = 'loading-message';
  el.innerHTML = `
    <span>Thinking</span>
    <div class="loading-dots">
      <span></span><span></span><span></span>
    </div>`;
  chatContainer.appendChild(el);
  scrollToBottom();
  return el;
}

function hideEmptyState() {
  if (emptyState) emptyState.style.display = 'none';
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function setLoadingState(loading) {
  isLoading = loading;
  sendBtn.disabled = loading;
  userInput.disabled = loading;
  if (loading) {
    sendBtn.textContent = '…';
  } else {
    sendBtn.textContent = '➤';
    userInput.focus();
  }
}

// ── Clear chat ─────────────────────────────────────────────────────────────────
async function handleClear() {
  // If we have a server-side conversation, tell the server to clear its messages.
  if (conversationId) {
    await sendMessage({ type: 'CLEAR_CHAT', payload: { conversationId } });
    conversationId = null;
  }

  // Clear the UI.
  chatContainer.innerHTML = '';
  chatContainer.appendChild(emptyState);
  emptyState.style.display = '';

  // Clear storage for this tab.
  await clearTabState();

  // Keep pageContext (the user does not need to re-analyze just to clear chat).
}

// ── Copy helpers ───────────────────────────────────────────────────────────────
function handleCopy() {
  // Find the last assistant message.
  const msgs = chatContainer.querySelectorAll('.message.assistant');
  if (msgs.length === 0) return;
  const last = msgs[msgs.length - 1];
  copyToClipboard(last.dataset.rawText || last.innerText, copyBtn);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    btn.textContent = 'Copy failed';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
  }
}

// ── Page bar ───────────────────────────────────────────────────────────────────
function updatePageBar(url, title) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    pageHostname.textContent = hostname;
  } catch {
    pageHostname.textContent = url ? url.slice(0, 30) : '—';
  }
  pageTitleText.textContent = title || '';
  pageTitleText.title = title || '';
}

function setPageStatus(message, type = '') {
  pageStatus.textContent = message;
  pageStatus.className = `page-status${type ? ' ' + type : ''}`;
}

// ── Markdown sanitiser ─────────────────────────────────────────────────────────
/**
 * Sanitise an HTML string by removing dangerous elements and attributes.
 *
 * Why not DOMPurify?
 *   DOMPurify is the gold standard but requires an external file.  For this
 *   project we keep the extension self-contained.  This function handles the
 *   most common injection vectors (scripts, event handlers, javascript: hrefs).
 *
 * Limitations:
 *   This is not a complete sanitiser.  For a public-facing product,
 *   include DOMPurify and use DOMPurify.sanitize(html).
 *
 * @param {string} html  - Raw HTML string from marked.parse()
 * @returns {string}     - Sanitised HTML string
 */
function sanitiseHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;

  // Remove dangerous elements.
  root.querySelectorAll('script, iframe, object, embed, form, input').forEach(el => el.remove());

  // Walk every element and strip dangerous attributes.
  root.querySelectorAll('*').forEach((el) => {
    // Remove all event handler attributes (onclick, onmouseover, …).
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }

    // Strip javascript: and data: hrefs / srcs.
    for (const attrName of ['href', 'src', 'action']) {
      const val = el.getAttribute(attrName);
      if (val && /^\s*(javascript|data|vbscript):/i.test(val)) {
        el.removeAttribute(attrName);
      }
    }
  });

  // Serialise back to string.
  const div = document.createElement('div');
  div.appendChild(root.cloneNode(true));
  return div.innerHTML;
}

// ── Messaging helper ───────────────────────────────────────────────────────────
/**
 * Send a message to background.js and return a promise.
 * Wraps chrome.runtime.sendMessage in a Promise so we can use async/await.
 */
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}
