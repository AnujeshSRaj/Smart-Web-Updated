-- Rate-limit counters are ephemeral; resetting them lets us add a required owner column safely.
TRUNCATE TABLE "api_rate_limits";
--> statement-breakpoint
DROP INDEX "api_rate_limits_expires_idx";
--> statement-breakpoint
ALTER TABLE "api_rate_limits" ADD COLUMN "user_id" uuid NOT NULL;
--> statement-breakpoint
CREATE INDEX "api_rate_limits_user_expires_idx" ON "api_rate_limits" USING btree ("user_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app_users_tenant_policy" ON "app_users" FOR ALL
  USING ("id" = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversations_tenant_policy" ON "conversations" FOR ALL
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "messages_tenant_policy" ON "messages" FOR ALL
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "api_rate_limits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_rate_limits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_rate_limits_tenant_policy" ON "api_rate_limits" FOR ALL
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);
