/**
 * routes/chat.routes.js
 * ──────────────────────
 * Responsibility : Map URL paths and HTTP methods to controller functions.
 *
 * Routes are kept thin — no business logic here, just wiring.
 *
 * Called by : app.js
 */

import { Router } from 'express';
import { handleChat } from '../controllers/chat.controller.js';
import {
  handleListConversations,
  handleGetConversation,
  handleDeleteConversation,
  handleClearConversation,
} from '../controllers/conversations.controller.js';
import { asyncHandler } from '../http/async-handler.js';
import { validateRequest } from '../middleware/validate-request.middleware.js';
import { ChatRequestSchema, ConversationIdSchema, ConversationMessagesParamsSchema } from '../schemas/chat.schema.js';

const router = Router();

// ── Chat ──────────────────────────────────────────────────────────────────────
// Send a message and get an AI response.
router.post('/chat', validateRequest(ChatRequestSchema), asyncHandler(handleChat));

// Clear all messages in a conversation (keeps the conversation row).
router.delete('/chat/:conversationId/messages', validateRequest(ConversationMessagesParamsSchema, 'params'), asyncHandler(handleClearConversation));

// ── Conversations (chat history) ──────────────────────────────────────────────
// List all stored conversations.
router.get('/conversations', asyncHandler(handleListConversations));

// Get a single conversation with its messages.
router.get('/conversations/:id', validateRequest(ConversationIdSchema, 'params'), asyncHandler(handleGetConversation));

// Delete a conversation and all its messages.
router.delete('/conversations/:id', validateRequest(ConversationIdSchema, 'params'), asyncHandler(handleDeleteConversation));

export default router;
