import { sql } from 'drizzle-orm';
import type { Platform } from '../lib/counters/platform-types.js';
import {
  bigserial,
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
 * sourceId: platform native id the API is called with, null means setup must run again
 * sourceName: handle shown to users, twitch display name or kick username
 * reason: last known disable reason
 * lastCheckedAt: last scheduler fetch, null means due immediately
 * lastStats: raw numbers from the last fetch that changed something
 */
export const panels = pgTable('panels', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  platform: varchar('platform', { length: 16 }).$type<Platform>().notNull(),
  enabled: boolean('enabled').notNull().default(false),
  sourceId: text('source_id'),
  sourceName: text('source_name'),
  reason: text('reason'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastStats: jsonb('last_stats').$type<Record<string, number>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('panels_guild_id_idx').on(t.guildId),
  uniqueIndex('panels_guild_platform_uq').on(t.guildId, t.platform),
  check('panels_platform_check', sql`${t.platform} in ('youtube', 'twitch', 'kick')`),
]);

/**
 * One voice channel of a panel whose name is rewritten.
 * type: category, subs, views, videos, followers or viewers
 * channelId: the voice channel whose name shows the stat
 * category is the renamed parent category, not a stat
 * enabled: whether this counter is rendered, lets the dashboard manage counters one by one
 * numberFormat: compact shows 123K, full shows 123456
 * template: name pattern like Subs: [subs], null falls back to the platform default
 * reason: last failure of just this counter, siblings keep updating
 */
export const counters = pgTable('counters', {
  id: serial('id').primaryKey(),
  panelId: integer('panel_id').notNull().references(() => panels.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 16 }).notNull(),
  channelId: text('channel_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  numberFormat: varchar('number_format', { length: 16 }).$type<'compact' | 'full'>().notNull().default('full'),
  template: text('template'),
  reason: text('reason'),
}, (t) => [
  index('counters_panel_id_idx').on(t.panelId),
  uniqueIndex('counters_panel_type_uq').on(t.panelId, t.type),
  check('counters_number_format_check', sql`${t.numberFormat} in ('compact', 'full')`),
]);

/**
 * Small runtime state as key value rows.
 * Quota rows use the key yt_quota_YYYY-MM-DD and hold {refresh, resolution} spent that UTC day.
 */
export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, number>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per slash command invocation.
 */
export const commandUsage = pgTable('command_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  command: text('command').notNull(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  ok: boolean('ok').notNull().default(true),
  detail: text('detail'),
}, (t) => [
  index('command_usage_created_at_idx').on(t.createdAt),
  index('command_usage_command_created_at_idx').on(t.command, t.createdAt),
  index('command_usage_guild_created_at_idx').on(t.guildId, t.createdAt),
]);

export type Guild = typeof guilds.$inferSelect;
export type NewGuild = typeof guilds.$inferInsert;
export type Panel = typeof panels.$inferSelect;
export type NewPanel = typeof panels.$inferInsert;
export type Counter = typeof counters.$inferSelect;
export type NewCounter = typeof counters.$inferInsert;
