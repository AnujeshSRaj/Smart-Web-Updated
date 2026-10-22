/**
 * tests/conversations.test.js
 * ───────────────────────────
 * Tests for /api/conversations endpoints.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.GROQ_API_KEY = 'test-key-not-real';
process.env.API_AUTH_TOKEN = 'test-api-token';

const { default: supertest } = await import('supertest');
const { default: app } = await import('../src/app.js');
const { setGroqCaller, resetGroqCaller } = await import('../src/services/groq.service.js');

const request = {
  get: (path) => supertest(app).get(path).set('X-Smart-Web-Token', 'test-api-token'),
  post: (path) => supertest(app).post(path).set('X-Smart-Web-Token', 'test-api-token'),
  delete: (path) => supertest(app).delete(path).set('X-Smart-Web-Token', 'test-api-token'),
};

describe('Conversations API', () => {
  beforeEach(() => {
    setGroqCaller(async () => 'Mocked response');
  });

  afterEach(() => {
    resetGroqCaller();
  });

  describe('GET /api/conversations', () => {
    it('returns an array', async () => {
      const res = await request.get('/api/conversations');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.conversations));
    });
  });

  describe('GET /api/conversations/:id', () => {
    it('returns 404 for unknown id', async () => {
      const res = await request.get('/api/conversations/00000000-0000-4000-8000-000000000000');
      assert.equal(res.status, 404);
    });

    it('returns conversation and messages for a valid id', async () => {
      // Create one via chat.
      const chat = await request.post('/api/chat').send({
        question: 'Test question',
        pageUrl: 'https://test.com',
      });
      const { conversationId } = chat.body;

      const res = await request.get(`/api/conversations/${conversationId}`);
      assert.equal(res.status, 200);
      assert.ok(res.body.conversation);
      assert.ok(Array.isArray(res.body.messages));
      assert.ok(res.body.messages.length >= 2); // user + assistant
    });
  });

  describe('DELETE /api/conversations/:id', () => {
    it('deletes a conversation', async () => {
      const chat = await request.post('/api/chat').send({ question: 'Delete me' });
      const { conversationId } = chat.body;

      const del = await request.delete(`/api/conversations/${conversationId}`);
      assert.equal(del.status, 200);

      // Should be gone now.
      const get = await request.get(`/api/conversations/${conversationId}`);
      assert.equal(get.status, 404);
    });
  });
});
