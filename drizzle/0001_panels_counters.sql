CREATE TABLE "counters" (
	"id" serial PRIMARY KEY NOT NULL,
	"panel_id" integer NOT NULL,
	"type" varchar(16) NOT NULL,
	"channel_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panels" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"platform" varchar(16) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"number_format" varchar(16) DEFAULT 'compact' NOT NULL,
	"source_id" text,
	"source_name" text,
	"reason" text,
	"customize" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panels_platform_check" CHECK ("panels"."platform" in ('youtube', 'twitch', 'kick')),
	CONSTRAINT "panels_number_format_check" CHECK ("panels"."number_format" in ('compact', 'full'))
);
--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counters_panel_id_idx" ON "counters" USING btree ("panel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "counters_panel_type_uq" ON "counters" USING btree ("panel_id","type");--> statement-breakpoint
CREATE INDEX "panels_guild_id_idx" ON "panels" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panels_guild_platform_uq" ON "panels" USING btree ("guild_id","platform");