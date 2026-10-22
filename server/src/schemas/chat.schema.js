/**
 * schemas/chat.schema.js
 * ──────────────────────
 * Responsibility : Define the exact shape of valid chat requests using Zod.
 *
 * Why Zod?
 *   Zod validates and type-narrows at runtime.  If the frontend sends a bad
 *   payload we return a 400 with a clear message instead of crashing later.
 *
 * Called by : chat.controller.js
 */

import { z } from 'zod';
import { SUPPORTED_GROQ_MODELS } from '../config/models.js';

export const ChatRequestSchema = z.object({
  // The question the user is asking right now.
  question: z
    .string({ required_error: 'question is required' })
    .min(1, 'question cannot be empty')
    .max(2000, 'question is too long (max 2000 chars)'),

  // Extracted text from the webpage.  Optional — the user might ask a general
  // question without a page loaded.
  pageContext: z
    .string()
    .max(50000, 'pageContext exceeds maximum size')
    .optional(),

  // The URL of the page, used to associate the conversation with a page.
  pageUrl: z.string().url('pageUrl must be a valid URL').optional(),

  // Human-readable page title.
  pageTitle: z.string().max(500).optional(),

  // An existing conversation ID to continue.  If omitted, a new conversation
  // is created.
  conversationId: z.string().uuid('conversationId must be a valid UUID').optional(),

  // Optional model preference
  model: z.enum(SUPPORTED_GROQ_MODELS).optional(),
}).strict();

// Schema for the conversations endpoint params.
export const ConversationIdSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

export const ConversationMessagesParamsSchema = z.object({
  conversationId: z.string().uuid('conversationId must be a valid UUID'),
});
