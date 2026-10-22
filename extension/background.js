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
importScripts('neon-auth.bundle.js');
const BACKEND_URL = globalThis.SMART_WEB_CONFIG.API_BASE_URL.replace(/\/$/, '');
const TIMEOUT_MS = 30_000;

async function loadAuthConfig() {
  const saved = await chrome.storage.local.get('authConfig');
  if (saved.authConfig?.neonAuthBaseUrl) return saved.authConfig;
  const response = await fetchWithTimeout(`${BACKEND_URL}/api/auth-config`);
  if (!response.ok) throw new Error('Could not load sign-in configuration.');
  const config = await response.json();
  await chrome.storage.local.set({ authConfig: config });
  return config;
}

let neonAuthClient;
async function getNeonAuth() {
  if (!neonAuthClient) {
    const config = await loadAuthConfig();
    neonAuthClient = NeonAuthBundle.createAuthClient(config.neonAuthBaseUrl);
  }
  return neonAuthClient;
}

async function currentSession(auth) {
  const response = await auth.getSession();
  const session = response?.data?.session;
  const user = response?.data?.user;
  return session?.token && user?.id
    ? { access_token: session.token, user: { id: user.id, email: user.email } }
    : null;
}

async function authedFetch(path, options = {}) {
  const auth = await getNeonAuth();
  const session = await currentSession(auth);
  if (!session?.access_token) throw new Error('Sign in to use Smart Web Assistant.');
  await chrome.storage.local.set({ userSession: session });
  const send = (token) => fetchWithTimeout(`${BACKEND_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  return send(session.access_token);
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
    case 'AUTH_CONFIG': {
      try { return { ok: true, data: await loadAuthConfig() }; }
      catch (err) { return { ok: false, error: err.message }; }
    }
    case 'AUTH_SIGN_IN':
    case 'AUTH_SIGN_UP': {
      try {
        const auth = await getNeonAuth();
        if (type === 'AUTH_SIGN_IN') await auth.signIn.email({ email: payload.email, password: payload.password });
        else await auth.signUp.email({ email: payload.email, password: payload.password, name: payload.email.split('@')[0] });
        const session = await currentSession(auth);
        if (session) await chrome.storage.local.set({ userSession: session });
        return { ok: true, data: session || {} };
      } catch (err) { return { ok: false, error: err.message }; }
    }
    case 'AUTH_SIGN_OUT': {
      try { await (await getNeonAuth()).signOut(); } catch { /* clear local state even if already expired */ }
      await chrome.storage.local.remove('userSession');
      return { ok: true };
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
