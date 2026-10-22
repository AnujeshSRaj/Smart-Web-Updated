'use strict';

const EXTENSION_ID = 'mcbffnibgfhofmbkcflfbekkdfmmkhge';
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode');
const extensionId = params.get('extension_id');
const state = params.get('state');
const form = document.getElementById('auth-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitButton = document.getElementById('submit-button');
const pageTitle = document.getElementById('page-title');
const status = document.getElementById('status');

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

function validateFlow() {
  if (!['signin', 'signup', 'signout'].includes(mode)) throw new Error('Invalid sign-in action. Reopen the extension and try again.');
  if (!state || !/^[a-f0-9-]{36}$/i.test(state)) throw new Error('Invalid sign-in state. Reopen the extension and try again.');
  if (extensionId !== EXTENSION_ID) throw new Error('This extension ID is not configured for sign-in.');
}

function sendResult(result) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error('Smart Web Assistant is not available in this browser.'));
      return;
    }
    chrome.runtime.sendMessage(EXTENSION_ID, {
      type: 'SMART_WEB_AUTH_COMPLETE',
      state,
      ...result,
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error('Could not return to the extension. Make sure it is enabled and try again.'));
      else if (!response?.ok) reject(new Error(response?.error || 'The extension rejected this sign-in.'));
      else resolve();
    });
  });
}

function getSessionToken(response) {
  if (response?.error) throw new Error(response.error.message || 'Neon Auth request failed.');
  const session = response?.data?.session;
  if (!session?.token || !response?.data?.user?.id) return null;
  return {
    token: session.token,
    email: response.data.user.email || '',
  };
}

async function initialize() {
  validateFlow();
  if (mode === 'signout') {
    form.hidden = true;
    pageTitle.textContent = 'Signing out';
  } else if (mode === 'signup') {
    pageTitle.textContent = 'Create your account';
    submitButton.textContent = 'Create account';
    passwordInput.autocomplete = 'new-password';
  }

  const authUrl = globalThis.SMART_WEB_AUTH_CONFIG?.neonAuthBaseUrl;
  if (!authUrl) throw new Error('Could not load sign-in settings.');
  const auth = NeonAuthBundle.createAuthClient(authUrl);

  if (mode === 'signout') {
    const signedOut = await auth.signOut();
    if (signedOut?.error) throw new Error(signedOut.error.message || 'Could not sign out.');
    await sendResult({ status: 'signed_out' });
    setStatus('You are signed out. You can close this tab.', 'success');
    return;
  }

  const existing = getSessionToken(await auth.getSession());
  if (existing) {
    await sendResult({ status: 'signed_in', token: existing.token, email: existing.email });
    form.hidden = true;
    setStatus('You are signed in. You can close this tab and return to the extension.', 'success');
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    setStatus(mode === 'signup' ? 'Creating account…' : 'Signing in…');
    try {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (mode === 'signup') {
        const created = await auth.signUp.email({
          email,
          password,
          name: email.split('@')[0],
          callbackURL: window.location.href,
        });
        if (created?.error) throw new Error(created.error.message || 'Could not create your account.');
      } else {
        const signedIn = await auth.signIn.email({ email, password });
        if (signedIn?.error) throw new Error(signedIn.error.message || 'Could not sign in.');
      }

      const session = getSessionToken(await auth.getSession());
      if (session) {
        await sendResult({ status: 'signed_in', token: session.token, email: session.email });
        form.hidden = true;
        setStatus('You are signed in. You can close this tab and return to the extension.', 'success');
        return;
      }
      if (mode === 'signup') {
        await sendResult({ status: 'verification_required' });
        setStatus('Account created. Check your email to verify it, then open the extension and sign in.', 'success');
        return;
      }
      throw new Error('Sign-in did not create a session. Check your email verification and try again.');
    } catch (error) {
      setStatus(error.message || 'Authentication failed. Please try again.', 'error');
      submitButton.disabled = false;
    }
  });
}

initialize().catch((error) => {
  setStatus(error.message || 'Could not start sign-in.', 'error');
  submitButton.disabled = true;
});
