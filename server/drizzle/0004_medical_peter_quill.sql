DROP INDEX "messages_conversation_created_idx";
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence_no" bigint;
--> statement-breakpoint
WITH ordered_messages AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS sequence_no
  FROM "messages"
)
UPDATE "messages" AS message
SET "sequence_no" = ordered_messages.sequence_no
FROM ordered_messages
WHERE message."id" = ordered_messages."id";
--> statement-breakpoint
CREATE SEQUENCE "messages_sequence_no_seq";
--> statement-breakpoint
SELECT setval('messages_sequence_no_seq', COALESCE((SELECT MAX("sequence_no") FROM "messages"), 0) + 1, false);
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sequence_no" SET DEFAULT nextval('messages_sequence_no_seq');
--> statement-breakpoint
ALTER SEQUENCE "messages_sequence_no_seq" OWNED BY "messages"."sequence_no";
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sequence_no" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "messages_conversation_sequence_idx" ON "messages" USING btree ("conversation_id", "sequence_no");
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sequence_no_unique" UNIQUE("sequence_no");
