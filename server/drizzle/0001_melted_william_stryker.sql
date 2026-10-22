CREATE TABLE "api_rate_limits" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"request_count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_rate_limits_expires_idx" ON "api_rate_limits" USING btree ("expires_at");