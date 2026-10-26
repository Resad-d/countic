CREATE TABLE "command_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command" text NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "panels" DROP CONSTRAINT "panels_number_format_check";--> statement-breakpoint
ALTER TABLE "counters" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "counters" ADD COLUMN "number_format" varchar(16) DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "counters" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "counters" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "last_stats" jsonb;--> statement-breakpoint
-- Backfill
UPDATE "counters" SET "number_format" = "panels"."number_format"
FROM "panels"
WHERE "counters"."panel_id" = "panels"."id"
	AND "counters"."type" in ('subs', 'followers');--> statement-breakpoint
-- Templates stored per counter type inside the panels.customize jsonb move onto the counter row.
UPDATE "counters" SET "template" = "panels"."customize" -> "counters"."type"
FROM "panels"
WHERE "counters"."panel_id" = "panels"."id"
	AND "panels"."customize" -> "counters"."type" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "command_usage_created_at_idx" ON "command_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "command_usage_command_created_at_idx" ON "command_usage" USING btree ("command","created_at");--> statement-breakpoint
CREATE INDEX "command_usage_guild_created_at_idx" ON "command_usage" USING btree ("guild_id","created_at");--> statement-breakpoint
ALTER TABLE "panels" DROP COLUMN "number_format";--> statement-breakpoint
ALTER TABLE "panels" DROP COLUMN "customize";--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_number_format_check" CHECK ("counters"."number_format" in ('compact', 'full'));