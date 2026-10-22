import { pgTable, uuid, text, integer, timestamp, index, pgEnum, unique, foreignKey, bigserial } from 'drizzle-orm/pg-core';

export const messageRole = pgEnum('message_role', ['user', 'assistant']);

// Mirrors the user ID from Neon Auth. Passwords and auth sessions remain managed by Neon.
export const users = pgTable('app_users', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageUrl: text('page_url').notNull().default('unknown'),
  pageTitle: text('page_title').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('conversations_user_updated_idx').on(table.userId, table.updatedAt),
  unique('conversations_id_user_unique').on(table.id, table.userId),
]);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sequenceNo: bigserial('sequence_no', { mode: 'number' }).notNull(),
  conversationId: uuid('conversation_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: messageRole('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('messages_conversation_sequence_idx').on(table.conversationId, table.sequenceNo),
  unique('messages_sequence_no_unique').on(table.sequenceNo),
  foreignKey({
    name: 'messages_conversation_user_fk',
    columns: [table.conversationId, table.userId],
    foreignColumns: [conversations.id, conversations.userId],
  }).onDelete('cascade'),
]);

// Shared fixed-window counters keep per-user quotas consistent across Cloud Run instances.
export const apiRateLimits = pgTable('api_rate_limits', {
  bucketKey: text('bucket_key').primaryKey(),
  userId: uuid('user_id').notNull(),
  requestCount: integer('request_count').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('api_rate_limits_user_expires_idx').on(table.userId, table.expiresAt),
]);
