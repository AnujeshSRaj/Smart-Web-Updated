/**
 * services/groq.service.js
 * ────────────────────────
 * Responsibility : Send a list of messages to the Groq API and return the
 *                 assistant's reply text.
 *
 * This module is the ONLY place that calls Groq.  Everything else in the app
 * just calls `callGroq(messages)`.  If we ever switch providers, we only
 * change this file.
 *
 * Inputs  : An array of { role, content } message objects.
 * Outputs : A string — the model's reply.
 * Throws  : An Error with a human-readable message and an optional statusCode.
 *
 * Called by : chat.controller.js
 */

import Groq from 'groq-sdk';
import { config } from '../config/env.js';
import { DEFAULT_GROQ_MODEL } from '../config/models.js';

// The Groq SDK reads GROQ_API_KEY from the environment automatically,
// but we pass it explicitly so we can validate it in config/env.js first.
const groq = new Groq({ apiKey: config.groq.apiKey });

// Upstream request timeout in milliseconds.
// AbortController lets us cancel the fetch if Groq takes too long.
const TIMEOUT_MS = 30_000;

function providerError(statusCode, code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { statusCode, code });
}

// Test hook for mocking the Groq API call without real credentials or external libraries
let customCaller = null;

export function setGroqCaller(fn) {
  customCaller = fn;
}

export function resetGroqCaller() {
  customCaller = null;
}

/**
 * Call the Groq chat completions API.
 * Supports BYOK (Bring Your Own Key) where users can provide their personal API key.
 *
 * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
 * @param {object} [options]
 * @param {string} [options.apiKey] - Optional user-provided Groq API key (overrides server key)
 * @param {string} [options.model]  - Optional model name override
 * @returns {Promise<string>} The assistant reply text.
 */
export async function callGroq(messages, options = {}) {
  if (customCaller) {
    return customCaller(messages, options);
  }

  // Use user-provided key if supplied; fallback to server environment key
  const effectiveApiKey = options.apiKey?.trim() || config.groq.apiKey;
  if (!effectiveApiKey) {
    throw providerError(401, 'GROQ_API_KEY_REQUIRED', 'No Groq API key found. Please enter your API key in extension Settings (⚙️).');
  }

  const client = new Groq({ apiKey: effectiveApiKey });
  const model = options.model?.trim() || config.groq.model;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages,
        temperature: 0.4,      // Slightly lower = more factual answers
        max_tokens: 1024,      // Limit response length
      },
      { signal: controller.signal }
    );

    // Validate the shape of the response before reading it.
    const choice = completion?.choices?.[0];
    if (!choice?.message?.content) {
      throw providerError(502, 'GROQ_INVALID_RESPONSE', 'Groq returned an unexpected response shape.');
    }

    return choice.message.content;

  } catch (err) {
    // A user's Groq plan may not expose the selected larger model. Retry once
    // with the default production model before returning the provider error.
    if (err.status === 404 && model !== DEFAULT_GROQ_MODEL) {
      try {
        console.warn(`[Groq] Model '${model}' not available for this key. Retrying with '${DEFAULT_GROQ_MODEL}'...`);
        const fallbackCompletion = await client.chat.completions.create(
          {
            model: DEFAULT_GROQ_MODEL,
            messages,
            temperature: 0.4,
            max_tokens: 1024,
          },
          { signal: controller.signal }
        );
        const fallbackChoice = fallbackCompletion?.choices?.[0];
        if (fallbackChoice?.message?.content) {
          return fallbackChoice.message.content;
        }
      } catch (retryErr) {
        // Fall through to error handler below
      }
    }

    // Re-throw with friendlier messages and appropriate HTTP status codes
    // so the error middleware can send the right response to the client.

    if (err.name === 'AbortError' || err.code === 'ERR_OPERATION_ABORTED') {
      throw providerError(504, 'GROQ_TIMEOUT', 'The AI request timed out. Please try again.', err);
    }

    if (err.status === 401) {
      throw providerError(401, 'GROQ_API_KEY_INVALID', 'Invalid Groq API key. Please check your key in extension Settings (⚙️).', err);
    }

    if (err.status === 404 || err.status === 400) {
      const detail = err.error?.message || err.message || 'Groq request rejected';
      throw providerError(400, 'GROQ_REQUEST_REJECTED', `Groq error: ${detail}`, err);
    }

    if (err.status === 429) {
      throw providerError(429, 'GROQ_RATE_LIMITED', 'Groq rate limit reached. Please wait a moment.', err);
    }

    if (err.status >= 500) {
      throw providerError(502, 'GROQ_UNAVAILABLE', 'Groq is currently unavailable. Please try again later.', err);
    }

    // For any other error, rethrow as-is (500 will be used by error middleware).
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
