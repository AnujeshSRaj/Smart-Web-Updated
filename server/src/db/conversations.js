import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, memoryStore } from './database.js';
import { setTenantContext } from './tenant-context.js';
import { users, conversations, messages } from './schema.js';

const now = () => new Date().toISOString();
const owned = (conversation, userId) => conversation && conversation.userId === userId;

export async function getConversation(id, userId) {
  if (memoryStore) return memoryStore.conversations.find((c) => c.id === id && owned(c, userId)) || null;
  return db.transaction(async (tx) => {
    await setTenantContext(tx, userId);
    const [row] = await tx.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId))).limit(1);
    return row || null;
  });
}

export async function listConversations(userId) {
  if (memoryStore) return memoryStore.conversations.filter((c) => owned(c, userId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return db.transaction(async (tx) => {
    await setTenantContext(tx, userId);
    return tx.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(desc(conversations.updatedAt));
  });
}

export async function deleteConversation(id, userId) {
  if (memoryStore) {
    memoryStore.conversations = memoryStore.conversations.filter((c) => !(c.id === id && owned(c, userId)));
    memoryStore.messages = memoryStore.messages.filter((m) => m.conversationId !== id);
    memoryStore.messageSequences.delete(id);
    return;
  }
  await db.transaction(async (tx) => {
    await setTenantContext(tx, userId);
    await tx.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
  });
}

/** Persist a new conversation or append to an owned conversation atomically. */
export async function persistExchange({ conversationId, pageUrl, pageTitle, userId, question, answer }) {
  if (memoryStore) {
    let conversation = conversationId
      ? memoryStore.conversations.find((c) => c.id === conversationId && owned(c, userId))
      : null;
    if (conversationId && !conversation) return null;
    if (!conversation) {
      conversation = { id: randomUUID(), userId, pageUrl: pageUrl || 'unknown', pageTitle: pageTitle || 'Untitled', createdAt: now(), updatedAt: now() };
      memoryStore.conversations.push(conversation);
    }
    if (!memoryStore.users.some((user) => user.id === userId)) memoryStore.users.push({ id: userId });
    const sequence = memoryStore.messageSequences.get(conversation.id) || 0;
    memoryStore.messages.push(
      { id: randomUUID(), sequenceNo: sequence + 1, conversationId: conversation.id, userId, role: 'user', content: question, createdAt: now() },
      { id: randomUUID(), sequenceNo: sequence + 2, conversationId: conversation.id, userId, role: 'assistant', content: answer, createdAt: now() },
    );
    memoryStore.messageSequences.set(conversation.id, sequence + 2);
    conversation.updatedAt = now();
    return conversation;
  }

  return db.transaction(async (tx) => {
    await setTenantContext(tx, userId);
    await tx.insert(users).values({ id: userId }).onConflictDoNothing({ target: users.id });
    let conversation;
    if (conversationId) {
      [conversation] = await tx.select().from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
        .limit(1);
      if (!conversation) return null;
    } else {
      [conversation] = await tx.insert(conversations).values({
        userId,
        pageUrl: pageUrl || 'unknown',
        pageTitle: pageTitle || 'Untitled',
      }).returning();
    }

    await tx.insert(messages).values([
      { conversationId: conversation.id, userId, role: 'user', content: question },
      { conversationId: conversation.id, userId, role: 'assistant', content: answer },
    ]);
    const [updated] = await tx.update(conversations).set({ updatedAt: new Date() })
      .where(and(eq(conversations.id, conversation.id), eq(conversations.userId, userId))).returning();
    return updated;
  });
}

export async function getMessages(conversationId, userId, limit) {
  if (memoryStore) {
    const rows = memoryStore.messages.filter((m) => m.conversationId === conversationId && m.userId === userId).sort((a, b) => a.sequenceNo - b.sequenceNo);
    return limit ? rows.slice(-limit) : rows;
  }
  return db.transaction(async (tx) => {
    await setTenantContext(tx, userId);
    const query = tx.select({
      id: messages.id,
      conversationId: messages.conversationId,
      userId: messages.userId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    }).from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.userId, userId)))
      .orderBy(limit ? desc(messages.sequenceNo) : asc(messages.sequenceNo));
    const rows = limit ? await query.limit(limit) : await query;
    return limit ? rows.reverse() : rows;
  });
}

export async function clearMessages(conversationId, userId) {
  if (memoryStore) {
    memoryStore.messages = memoryStore.messages.filter((m) => !(m.conversationId === conversationId && m.userId === userId));
    const c = memoryStore.conversations.find((row) => row.id === conversationId && owned(row, userId));
    if (c) c.updatedAt = now();
    return;
  }
  await db.transaction(async (tx) => {
    await setTenantContext(tx, userId);
    await tx.delete(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.userId, userId)));
    await tx.update(conversations).set({ updatedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  });
}
