import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/** Drizzle schema. One row per Discord guild that has used the bot. */

export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  locale: varchar('locale', { length: 8 }).notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Panel config for one platform of one guild.
 * platform: youtube, twitch or kick
 * enabled: whether the scheduler updates this panel
 * numberFormat: compact shows 123K, full shows 123456
 * sourceId: platform native id the API is called with, null means setup must run again
 * sourceName: handle shown to users, twitch display name or kick username
 * reason: last known disable reason
 * customize: counter name templates like Subs: [subs], keys are counter types
 */
export const panels = pgTable('panels', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  platform: varchar('platform', { length: 16 }).notNull(),
  enabled: boolean('enabled').notNull().default(false),
  numberFormat: varchar('number_format', { length: 16 }).notNull().default('compact'),
  sourceId: text('source_id'),
  sourceName: text('source_name'),
  reason: text('reason'),
  customize: jsonb('customize').$type<Record<string, string>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('panels_guild_id_idx').on(t.guildId),
  uniqueIndex('panels_guild_platform_uq').on(t.guildId, t.platform),
  check('panels_platform_check', sql`${t.platform} in ('youtube', 'twitch', 'kick')`),
  check('panels_number_format_check', sql`${t.numberFormat} in ('compact', 'full')`),
]);

/**
 * One voice channel of a panel whose name is rewritten.
 * type: category, subs, views, videos, followers or viewers
 * channelId: the voice channel whose name shows the stat
 * category is the renamed parent category, not a stat
 */
export const counters = pgTable('counters', {
  id: serial('id').primaryKey(),
  panelId: integer('panel_id').notNull().references(() => panels.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 16 }).notNull(),
  channelId: text('channel_id').notNull(),
}, (t) => [
  index('counters_panel_id_idx').on(t.panelId),
  uniqueIndex('counters_panel_type_uq').on(t.panelId, t.type),
]);

export type Guild = typeof guilds.$inferSelect;
export type NewGuild = typeof guilds.$inferInsert;
export type Panel = typeof panels.$inferSelect;
export type NewPanel = typeof panels.$inferInsert;
export type Counter = typeof counters.$inferSelect;
export type NewCounter = typeof counters.$inferInsert;
