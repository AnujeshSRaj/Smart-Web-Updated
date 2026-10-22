import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.GROQ_API_KEY = 'test-key-not-real';
process.env.CORS_ORIGINS = 'http://localhost:3000,chrome-extension://test-extension-id';

const { default: supertest } = await import('supertest');
const { default: app } = await import('../src/app.js');
const { config } = await import('../src/config/env.js');
const { setJwksProviderForTests } = await import('../src/middleware/auth.middleware.js');
const { consumeRateLimit } = await import('../src/db/rate-limits.js');
const { generateKeyPair, SignJWT } = await import('jose');
const { setGroqCaller, resetGroqCaller } = await import('../src/services/groq.service.js');
const request = supertest(app);

describe('API communication security', () => {
  it('keeps local development loopback-only', () => {
    assert.equal(config.host, '127.0.0.1');
  });

  it('keeps health public but requires user auth for API data routes', async () => {
    assert.equal((await request.get('/api/health')).status, 200);
    const authConfig = await request.get('/api/auth-config');
    assert.equal(authConfig.status, 200);
    assert.deepEqual(Object.keys(authConfig.body), ['neonAuthBaseUrl']);
    const routes = [
      () => request.post('/api/chat').send({ question: 'hello' }),
      () => request.post('/api/chat').set('X-Groq-API-Key', 'groq-key-alone-is-not-auth').send({ question: 'hello' }),
      () => request.get('/api/conversations'),
      () => request.get('/api/conversations/00000000-0000-4000-8000-000000000000'),
      () => request.delete('/api/conversations/00000000-0000-4000-8000-000000000000'),
      () => request.delete('/api/chat/00000000-0000-4000-8000-000000000000/messages'),
    ];

    for (const makeRequest of routes) {
      const response = await makeRequest();
      assert.equal(response.status, 401);
      assert.equal(response.body.error, 'Authentication required.');
    }
  });

  it('rejects invalid credentials and does not accept a token in the body', async () => {
    const badHeader = await request.post('/api/chat').set('Authorization', 'Bearer invalid').send({ question: 'Hi' });
    const bodyToken = await request.post('/api/chat').send({
      apiToken: 'test-api-token',
      question: 'hello',
    });
    const queryToken = await request.get('/api/conversations?apiToken=test-api-token');
    assert.equal(badHeader.status, 401);
    assert.equal(bodyToken.status, 401);
    assert.equal(queryToken.status, 401);
  });

  it('verifies Neon Auth JWT signatures and rejects tampered tokens', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    setJwksProviderForTests(async () => publicKey);
    const userId = '30000000-0000-4000-8000-000000000003';
    const validToken = await new SignJWT({ email: 'neon-user@example.test' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(config.neonAuthBaseUrl)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    assert.equal((await request.get('/api/conversations').set('Authorization', `Bearer ${validToken}`)).status, 200);
    const { privateKey: otherPrivateKey } = await generateKeyPair('RS256');
    const wrongSignatureToken = await new SignJWT({ email: 'neon-user@example.test' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(config.neonAuthBaseUrl)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(otherPrivateKey);
    assert.equal((await request.get('/api/conversations').set('Authorization', `Bearer ${wrongSignatureToken}`)).status, 401);
    assert.equal((await request.get('/api/conversations').set('Authorization', 'Bearer malformed')).status, 401);
  });

  it('shares quota by user and starts a fresh fixed window at reset', async () => {
    const now = 1_800_000_000_000;
    const params = { userId: 'user-a', scope: 'chat', limit: 2, windowMs: 60_000, now };
    assert.equal((await consumeRateLimit(params)).allowed, true);
    assert.equal((await consumeRateLimit(params)).allowed, true);
    assert.equal((await consumeRateLimit(params)).allowed, false);
    assert.equal((await consumeRateLimit({ ...params, userId: 'user-b' })).allowed, true);
    assert.equal((await consumeRateLimit({ ...params, now: now + 60_000 })).allowed, true);
  });

  it('keeps forced tenant RLS policies and transaction-local identity in the migration', async () => {
    const migration = await readFile(new URL('../drizzle/0003_wooden_invisible_woman.sql', import.meta.url), 'utf8');
    const tenantContext = await readFile(new URL('../src/db/tenant-context.js', import.meta.url), 'utf8');
    for (const table of ['app_users', 'conversations', 'messages', 'api_rate_limits']) {
      assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
      assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    }
    assert.match(migration, /current_setting\('app\.user_id', true\)/);
    assert.match(tenantContext, /set_config\('app\.user_id', \$\{userId\}, true\)/);
  });

  it('allows configured extension origins and denies unlisted origins', async () => {
    const allowed = await request
      .options('/api/chat')
      .set('Origin', 'chrome-extension://test-extension-id')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers['access-control-allow-origin'], 'chrome-extension://test-extension-id');
    assert.match(allowed.headers['access-control-allow-headers'], /authorization/i);

    const denied = await request
      .options('/api/chat')
      .set('Origin', 'chrome-extension://unlisted-extension')
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  });

  it('sets standard browser security headers on API responses', async () => {
    const response = await request
      .get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
  });

  it('isolates conversations between verified user identities', async () => {
    setGroqCaller(async () => 'isolated response');
    const alice = (path) => request.post(path).set('X-Smart-Web-Token', 'test-api-token').set('X-Test-User', 'alice');
    const bobGet = (path) => request.get(path).set('X-Smart-Web-Token', 'test-api-token').set('X-Test-User', 'bob');
    const created = await alice('/api/chat').send({ question: 'private to Alice' });
    assert.equal(created.status, 200);
    assert.equal((await bobGet('/api/conversations')).body.conversations.length, 0);
    assert.equal((await bobGet(`/api/conversations/${created.body.conversationId}`)).status, 404);
    resetGroqCaller();
  });
});

describe('Extension to backend credential forwarding', () => {
  it('uses HTTPS deployment config and a bearer session for chat calls', async () => {
    const backgroundSource = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
    const calls = [];
    let onMessage;
    const data = { userSession: { access_token: 'user-access-token', user: { id: 'user-1' } } };
    const chrome = {
      runtime: { onMessage: { addListener(listener) { onMessage = listener; } } },
      storage: { local: {
        async get(key) { return { [key]: data[key] }; },
        async set(value) { Object.assign(data, value); },
        async remove(key) { delete data[key]; },
      } },
    };
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/api/auth-config')
        ? ({ neonAuthBaseUrl: 'https://auth.example.test/neondb/auth' })
        : ({ status: 'ok' }) };
    };
    runInNewContext(backgroundSource, {
      chrome, fetch, AbortController, setTimeout, clearTimeout, console,
      SMART_WEB_CONFIG: { API_BASE_URL: 'https://backend.example.test' },
      NeonAuthBundle: { createAuthClient: () => ({
        getJWTToken: async () => 'user-access-token',
        getSession: async () => ({ data: { user: { id: 'user-1', email: 'user@example.test' } } }),
      }) },
      importScripts() {},
    });

    const dispatch = (message) => new Promise((resolve) => onMessage(message, {}, resolve));
    await dispatch({ type: 'HEALTH_CHECK' });
    await dispatch({ type: 'CHAT', payload: { apiKey: 'groq-secret', question: 'Hi' } });
    await dispatch({ type: 'CLEAR_CHAT', payload: { conversationId: 'abc' } });

    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.match(call.url, /^https:\/\/backend\.example\.test/);
    }
    const chatCall = calls.find((call) => call.url.endsWith('/api/chat'));
    assert.equal(chatCall.options.headers.Authorization, 'Bearer user-access-token');
    assert.equal(chatCall.options.headers['X-Groq-API-Key'], 'groq-secret');
    assert.equal(JSON.parse(chatCall.options.body).apiKey, undefined);
  });
});
