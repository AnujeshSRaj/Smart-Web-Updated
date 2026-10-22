import {
  listUserConversations,
  getUserConversation,
  removeUserConversation,
  clearUserConversation,
} from '../services/conversations.service.js';

/** Thin transport adapters: authenticated identity comes only from auth middleware. */
export async function handleListConversations(req, res) {
  res.json({ conversations: await listUserConversations(req.user.id) });
}

export async function handleGetConversation(req, res) {
  res.json(await getUserConversation(req.params.id, req.user.id));
}

export async function handleDeleteConversation(req, res) {
  await removeUserConversation(req.params.id, req.user.id);
  res.json({ ok: true });
}

export async function handleClearConversation(req, res) {
  await clearUserConversation(req.params.conversationId, req.user.id);
  res.json({ ok: true, message: 'Chat history cleared.' });
}
