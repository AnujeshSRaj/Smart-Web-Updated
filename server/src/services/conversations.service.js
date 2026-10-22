import { createError } from '../errors/app-error.js';
import { listConversations, getConversation, getMessages, deleteConversation, clearMessages } from '../db/conversations.js';

export async function listUserConversations(userId) {
  return listConversations(userId);
}

export async function getUserConversation(id, userId) {
  const conversation = await getConversation(id, userId);
  if (!conversation) throw createError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  const messages = await getMessages(id, userId);
  return { conversation, messages };
}

export async function removeUserConversation(id, userId) {
  const conversation = await getConversation(id, userId);
  if (!conversation) throw createError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  await deleteConversation(id, userId);
}

export async function clearUserConversation(id, userId) {
  const conversation = await getConversation(id, userId);
  if (!conversation) throw createError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  await clearMessages(id, userId);
}
