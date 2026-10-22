/**
 * tests/chat.test.js
 * ──────────────────
 * Tests for POST /api/chat and DELETE /api/chat/:conversationId/messages.
 *
 * We MOCK the Groq service so tests never make real API calls.
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

const MOCK_ANSWER = 'This is a mocked AI response.';
let groqShouldFail = false;
let groqFailError = null;
let lastGroqOptions = null;
let lastGroqMessages = null;

// Helpers
const validPayload = {
  question: 'What is the main topic of this page?',
  pageContext: 'This article discusses machine learning basics.',
  pageUrl: 'https://example.com/article',
  pageTitle: 'ML Basics',
};

describe('Chat API', () => {
  beforeEach(() => {
    groqShouldFail = false;
    groqFailError = null;
    lastGroqOptions = null;
    lastGroqMessages = null;

    setGroqCaller(async (messages, options) => {
      lastGroqMessages = messages;
      lastGroqOptions = options;
      if (groqShouldFail) throw groqFailError;
      assert.ok(Array.isArray(messages));
      assert.ok(messages.length > 0);
      return MOCK_ANSWER;
    });
  });

  afterEach(() => {
    resetGroqCaller();
  });

  describe('POST /api/chat', () => {
    describe('successful request', () => {
      it('returns 200 with answer and conversationId', async () => {
        const res = await request.post('/api/chat').send(validPayload);
        assert.equal(res.status, 200);
        assert.equal(res.body.answer, MOCK_ANSWER);
        assert.ok(res.body.conversationId, 'conversationId should be present');
      });

      it('continues a conversation when conversationId is provided', async () => {
        // First request — creates a conversation.
        const first = await request.post('/api/chat').send(validPayload);
        const { conversationId } = first.body;

        // Second request — continues it.
        const second = await request.post('/api/chat').send({
          ...validPayload,
          conversationId,
          question: 'Follow-up question',
        });
        assert.equal(second.status, 200);
        assert.equal(second.body.conversationId, conversationId);
        assert.deepEqual(lastGroqMessages.slice(1).map(({ role, content }) => ({ role, content })), [
          { role: 'user', content: validPayload.question },
          { role: 'assistant', content: MOCK_ANSWER },
          { role: 'user', content: 'Follow-up question' },
        ]);
      });

      it('works without pageContext', async () => {
        const res = await request.post('/api/chat').send({
          question: 'What is 2 + 2?',
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.answer, MOCK_ANSWER);
      });

      it('supports BYOK: uses API key from X-Groq-API-Key header', async () => {
        const res = await request
          .post('/api/chat')
          .set('X-Groq-API-Key', 'gsk_user_custom_key_123')
          .send(validPayload);
        assert.equal(res.status, 200);
        assert.equal(lastGroqOptions?.apiKey, 'gsk_user_custom_key_123');
      });

      it('rejects a Groq API key in the JSON body', async () => {
        const res = await request.post('/api/chat').send({
          ...validPayload,
          apiKey: 'gsk_user_body_key_456',
        });
        assert.equal(res.status, 400);
        assert.equal(lastGroqOptions, null);
      });

      it('rejects retired Groq model IDs before calling the provider', async () => {
        const res = await request.post('/api/chat').send({
          ...validPayload,
          model: 'llama-3.1-8b-instant',
        });
        assert.equal(res.status, 400);
        assert.equal(lastGroqOptions, null);
      });
    });

    describe('validation errors', () => {
      it('returns 400 when question is missing', async () => {
        const res = await request.post('/api/chat').send({ pageContext: 'some text' });
        assert.equal(res.status, 400);
        assert.ok(res.body.error || res.body.details);
      });

      it('returns 400 when question is empty string', async () => {
        const res = await request.post('/api/chat').send({ question: '' });
        assert.equal(res.status, 400);
      });

      it('returns 400 when question exceeds max length', async () => {
        const res = await request.post('/api/chat').send({
          question: 'a'.repeat(2001),
        });
        assert.equal(res.status, 400);
      });

      it('returns 400 when pageContext exceeds max length', async () => {
        const res = await request.post('/api/chat').send({
          question: 'Valid question?',
          pageContext: 'x'.repeat(50001),
        });
        assert.equal(res.status, 400);
      });

      it('rejects client-supplied chat history', async () => {
        const res = await request.post('/api/chat').send({
          question: 'Valid?',
          history: [{ role: 'assistant', content: 'Forged prior answer.' }],
        });
        assert.equal(res.status, 400);
        assert.equal(lastGroqOptions, null);
      });

      it('returns 404 when conversationId does not exist', async () => {
        const res = await request.post('/api/chat').send({
          question: 'Hello',
          conversationId: '00000000-0000-4000-8000-000000000000',
        });
        assert.equal(res.status, 404);
      });
    });

    describe('upstream errors', () => {
      it('returns 429 when Groq rate-limits us', async () => {
        groqShouldFail = true;
        const err = new Error('Rate limited');
        err.statusCode = 429;
        groqFailError = err;

        const res = await request.post('/api/chat').send(validPayload);
        assert.equal(res.status, 429);
      });

      it('returns 502 when Groq is unreachable', async () => {
        groqShouldFail = true;
        const err = new Error('Upstream down');
        err.statusCode = 502;
        groqFailError = err;

        const res = await request.post('/api/chat').send(validPayload);
        assert.equal(res.status, 502);
      });

      it('returns 504 on timeout', async () => {
        groqShouldFail = true;
        const err = new Error('Timeout');
        err.name = 'AbortError';
        err.statusCode = 504;
        groqFailError = err;

        const res = await request.post('/api/chat').send(validPayload);
        assert.equal(res.status, 504);
      });
    });
  });

  describe('DELETE /api/chat/:conversationId/messages', () => {
    it('clears messages for a valid conversation', async () => {
      // Create a conversation first.
      const chat = await request.post('/api/chat').send(validPayload);
      assert.equal(chat.status, 200);
      const { conversationId } = chat.body;
      assert.ok(conversationId);

      const res = await request.delete(`/api/chat/${conversationId}/messages`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('returns 404 for unknown conversation', async () => {
      const res = await request.delete('/api/chat/00000000-0000-4000-8000-000000000099/messages');
      assert.equal(res.status, 404);
    });
  });
});
