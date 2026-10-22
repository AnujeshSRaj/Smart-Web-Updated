/**
 * background.js  (Service Worker)
 * ────────────────────────────────
 * Responsibility : Act as the bridge between the popup and the backend server.
 *
 * Why does the extension need a background service worker?
 *   Chrome extension popups are destroyed when they close.  The service worker
 *   persists (for a while) and can hold the backend URL and other config
 *   centrally.  More importantly, it is the only place where we can safely
 *   make fetch() calls to our server without CORS complications from the popup.
 *
 * The popup sends messages here using chrome.runtime.sendMessage().
 * This script handles each message and replies.
 *
 * Message types handled:
 *   HEALTH_CHECK  — ping the backend
 *   EXTRACT_AND_INDEX — not used here (extraction is done in popup.js)
 *   CHAT          — send a chat request to the backend
 *   CLEAR_CHAT    — clear messages for a conversation
 *   GET_TAB_INFO  — return the active tab's URL and title
 *
 * Security:
 *   The backend URL is defined here, not in popup.js.
 *   Backend auth and optional Groq credentials are stored in extension storage.
 */

importScripts('config.js');
const BACKEND_URL = globalThis.SMART_WEB_CONFIG.API_BASE_URL.replace(/\/$/, '');
const TIMEOUT_MS = 30_000;

async function authedFetch(path, options = {}) {
  const { userSession } = await chrome.storage.local.get('userSession');
  if (!userSession?.access_token) throw new Error('Sign in to use Smart Web Assistant.');
  const response = await fetchWithTimeout(`${BACKEND_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${userSession.access_token}` },
  });
  if (response.status === 401) {
    await chrome.storage.local.remove('userSession');
    throw new Error('Your sign-in expired. Open Settings and sign in again.');
  }
  return response;
}

function readJwtClaims(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
  } catch {
    throw new Error('Neon Auth returned an invalid sign-in token.');
  }
}

async function startHostedAuth(mode) {
  const state = crypto.randomUUID();
  const authUrl = new URL(`${BACKEND_URL}/extension-auth`);
  authUrl.searchParams.set('mode', mode);
  authUrl.searchParams.set('extension_id', chrome.runtime.id);
  authUrl.searchParams.set('state', state);
  await chrome.storage.local.set({ pendingAuth: { state, mode, createdAt: Date.now() } });
  if (mode === 'signout') await chrome.storage.local.remove('userSession');
  await chrome.tabs.create({ url: authUrl.toString(), active: true });
  return { ok: true, data: { authStarted: true } };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleExternalAuth(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message || 'Could not finish sign-in.' });
  });
  return true;
});

async function handleExternalAuth(message, sender) {
  let source;
  try { source = new URL(sender.url); } catch { throw new Error('Untrusted sign-in page.'); }
  const expectedOrigin = new URL(BACKEND_URL).origin;
  if (source.origin !== expectedOrigin || source.pathname !== '/extension-auth') {
    throw new Error('Untrusted sign-in page.');
  }
  if (message?.type !== 'SMART_WEB_AUTH_COMPLETE') throw new Error('Unknown sign-in response.');

  const { pendingAuth } = await chrome.storage.local.get('pendingAuth');
  const pendingLifetime = pendingAuth?.mode === 'signup' ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
  if (!pendingAuth || pendingAuth.state !== message.state || Date.now() - pendingAuth.createdAt > pendingLifetime) {
    await chrome.storage.local.remove('pendingAuth');
    throw new Error('Sign-in expired. Reopen Settings and try again.');
  }

  if (message.status === 'verification_required' && pendingAuth.mode === 'signup') {
    await chrome.storage.local.set({ authNotice: 'Account created. Check your email to verify it, then sign in.' });
    return { ok: true };
  }
  await chrome.storage.local.remove('pendingAuth');
  if (message.status === 'signed_out' && pendingAuth.mode === 'signout') {
    await chrome.storage.local.remove('userSession');
    return { ok: true };
  }
  if (message.status !== 'signed_in' || typeof message.token !== 'string') {
    throw new Error('Neon Auth did not return a session. Try signing in again.');
  }

  const claims = readJwtClaims(message.token);
  const isUuid = typeof claims.sub === 'string'
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(claims.sub);
  if (!isUuid || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new Error('Neon Auth returned an invalid or expired session. Try again.');
  }
  const session = {
    access_token: message.token,
    user: { id: claims.sub, email: typeof message.email === 'string' ? message.email : claims.email || '' },
  };
  await chrome.storage.local.set({ userSession: session });
  return { ok: true };
}

/**
 * Wrapper around fetch() that adds a timeout via AbortController.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Parse a fetch response and return { ok, data, error }.
 * Errors from the server are returned as { ok: false, error: string }.
 */
async function parseResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: 'Server returned invalid JSON.' };
  }

  if (!response.ok) {
    const message =
      data?.error ||
      (data?.details && data.details.map((d) => d.message).join(', ')) ||
      `Server error ${response.status}`;
    return { ok: false, error: message };
  }

  return { ok: true, data };
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We must return true to tell Chrome we will call sendResponse asynchronously.
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message || 'Background script error.' });
  });
  return true;
});

async function handleMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'AUTH_SIGN_IN':
      try { return await startHostedAuth('signin'); }
      catch (err) { return { ok: false, error: err.message }; }
    case 'AUTH_SIGN_UP':
      try { return await startHostedAuth('signup'); }
      catch (err) { return { ok: false, error: err.message }; }
    case 'AUTH_SIGN_OUT': {
      try { return await startHostedAuth('signout'); }
      catch (err) {
        await chrome.storage.local.remove('userSession');
        return { ok: false, error: err.message };
      }
    }
    // ── HEALTH_CHECK ─────────────────────────────────────────────────────────
    case 'HEALTH_CHECK': {
      try {
        const res = await fetchWithTimeout(`${BACKEND_URL}/api/health`);
        const parsed = await parseResponse(res);
        return parsed;
      } catch (err) {
        if (err.name === 'AbortError') {
          return { ok: false, error: 'Backend connection timed out.' };
        }
        return { ok: false, error: err.message || 'Backend health request failed.' };
      }
    }

    // ── CHAT ─────────────────────────────────────────────────────────────────
    case 'CHAT': {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (payload?.apiKey) {
          headers['X-Groq-API-Key'] = payload.apiKey;
        }
        const requestPayload = { ...payload };
        delete requestPayload.apiKey;

        const res = await authedFetch('/api/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify(requestPayload),
        });
        return await parseResponse(res);
      } catch (err) {
        if (err.name === 'AbortError') {
          return { ok: false, error: 'Request timed out. The AI is taking too long.' };
        }
        return { ok: false, error: err.message || 'Backend chat request failed.' };
      }
    }

    // ── CLEAR_CHAT ───────────────────────────────────────────────────────────
    case 'CLEAR_CHAT': {
      const { conversationId } = payload;
      try {
        const res = await authedFetch(`/api/chat/${conversationId}/messages`, { method: 'DELETE' });
        return await parseResponse(res);
      } catch (err) {
        return { ok: false, error: 'Could not clear chat. Is the server running?' };
      }
    }

    // ── GET_TAB_INFO ─────────────────────────────────────────────────────────
    case 'GET_TAB_INFO': {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return { ok: false, error: 'No active tab found.' };
        return { ok: true, data: { tabId: tab.id, url: tab.url, title: tab.title } };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    default:
      return { ok: false, error: `Unknown message type: ${type}` };
  }
}

// When a tab navigates to a new URL, we do not auto-clear storage.
// The popup checks whether the stored URL matches the current tab URL and
// prompts the user to re-analyze if they differ.
