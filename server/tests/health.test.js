/**
 * tests/health.test.js
 * ────────────────────
 * Tests the GET /api/health endpoint.
 *
 * How tests work here:
 *  - We import `app` (not `server`) so we never actually bind to a port.
 *  - `supertest(app)` makes HTTP-like requests to the app in-process.
 *  - We use Node's built-in test runner (node --test).
 *
 * To run: cd server && npm test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// We must set GROQ_API_KEY before importing app, because config/env.js
// validates it at load time.  In tests we use a dummy value.
process.env.GROQ_API_KEY = 'test-key-not-real';
process.env.NODE_ENV = 'test';
process.env.API_AUTH_TOKEN = 'test-api-token';

// Lazy import after env is set.
const { default: supertest } = await import('supertest');
const { default: app } = await import('../src/app.js');

const request = {
  get: (path) => supertest(app).get(path).set('X-Smart-Web-Token', 'test-api-token'),
};

describe('GET /', () => {
  it('serves a small public homepage for the deployed API', async () => {
    const res = await request.get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Smart Web Assistant API/);
    assert.match(res.text, /\/api\/health/);
    assert.match(res.text, /\/api\/ready/);
  });
});

describe('GET /extension-auth', () => {
  it('serves the hosted sign-in page used by the extension', async () => {
    const res = await request.get('/extension-auth');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Smart Web Assistant/);
    assert.match(res.text, /auth-form/);
  });

  it('serves the bundled Neon Auth client from the repository source', async () => {
    const res = await request.get('/auth-assets/neon-auth.bundle.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.text, /createAuthClient/);
  });

  it('serves the public Neon Auth URL for the hosted sign-in page', async () => {
    const res = await request.get('/auth-assets/auth-config.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.text, /SMART_WEB_AUTH_CONFIG/);
    assert.match(res.text, /"neonAuthBaseUrl":"https:\/\//);
  });
});

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('includes model name', async () => {
    const res = await request.get('/api/health');
    assert.ok(res.body.model, 'model field should be present');
  });

  it('includes timestamp', async () => {
    const res = await request.get('/api/health');
    assert.ok(res.body.timestamp, 'timestamp field should be present');
    // Verify it is a valid ISO date string.
    assert.doesNotThrow(() => new Date(res.body.timestamp));
  });

  it('does not expose the API key', async () => {
    const res = await request.get('/api/health');
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('test-key'), 'API key must not appear in response');
  });

  it('exposes a separate readiness check that verifies the database adapter', async () => {
    const res = await request.get('/api/ready');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ready' });
  });
});
