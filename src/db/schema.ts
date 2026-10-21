import { pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

/** Drizzle schema. One row per Discord guild that has used the bot. */

export const guilds = pgTable('guilds', {
  /** Discord guild id. */
  id: text('id').primaryKey(),
  /** UI language for this guild. */
  locale: varchar('locale', { length: 8 }).notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Guild = typeof guilds.$inferSelect;
export type NewGuild = typeof guilds.$inferInsert;
