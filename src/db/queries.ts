import { db } from './client.js';
import { commandUsage, counters, guilds, panels } from './schema.js';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Platform } from '../lib/counters/platform-types.js';

/** Panel and bookkeeping queries. */

// Insert if missing, ignore if present.
export async function ensureGuild(id: string): Promise<void> {
  await db.insert(guilds).values({ id }).onConflictDoNothing();
}

export type DuePanel = {
  id: number;
  guildId: string;
  locale: string;
  platform: Platform;
  sourceId: string;
  sourceName: string | null;
};

/**
 * Panels whose cadence elapsed, restricted to the calling shard.
 * The shard formula mirrors discord.js so the DB hands each shard only its own guilds.
 */
export async function selectDuePanels(
  platform: Platform,
  cadenceMinutes: number,
  shardId: number,
  shardCount: number,
  limit: number,
): Promise<DuePanel[]> {
  const rows = await db
    .select({
      id: panels.id,
      guildId: panels.guildId,
      locale: guilds.locale,
      platform: panels.platform,
      sourceId: panels.sourceId,
      sourceName: panels.sourceName,
    })
    .from(panels)
    .innerJoin(guilds, eq(guilds.id, panels.guildId))
    .where(
      and(
        eq(panels.enabled, true),
        eq(panels.platform, platform),
        isNotNull(panels.sourceId),
        or(
          isNull(panels.lastCheckedAt),
          lte(panels.lastCheckedAt, sql`now() - ${cadenceMinutes} * interval '1 minute'`),
        ),
        sql`(${panels.guildId}::bigint >> 22) % ${shardCount} = ${shardId}`,
      ),
    )
    .orderBy(panels.lastCheckedAt, panels.id)
    .limit(limit);
  return rows as DuePanel[];
}

export type PanelCounter = {
  id: number;
  panelId: number;
  type: string;
  channelId: string;
  enabled: boolean;
  numberFormat: 'compact' | 'full';
  template: string | null;
};

export async function selectCounters(panelIds: number[]): Promise<PanelCounter[]> {
  if (panelIds.length === 0) {
    return [];
  }
  return db
    .select({
      id: counters.id,
      panelId: counters.panelId,
      type: counters.type,
      channelId: counters.channelId,
      enabled: counters.enabled,
      numberFormat: counters.numberFormat,
      template: counters.template,
    })
    .from(counters)
    .where(and(inArray(counters.panelId, panelIds), eq(counters.enabled, true)));
}

// Stats only change the row when the numbers changed, the clock always moves.
export async function markChecked(panelId: number): Promise<void> {
  await db.update(panels).set({ lastCheckedAt: sql`now()` }).where(eq(panels.id, panelId));
}

export async function markCheckedWithStats(panelId: number, stats: Record<string, number>): Promise<void> {
  await db
    .update(panels)
    .set({ lastCheckedAt: sql`now()`, lastStats: stats })
    .where(eq(panels.id, panelId));
}

export async function disablePanel(panelId: number, reason: string): Promise<void> {
  await db
    .update(panels)
    .set({ enabled: false, reason, updatedAt: sql`now()` })
    .where(eq(panels.id, panelId));
}

export async function disableCounter(counterId: number, reason: string): Promise<void> {
  await db.update(counters).set({ enabled: false, reason }).where(eq(counters.id, counterId));
}

export async function insertCommandUsage(entry: {
  command: string;
  guildId: string;
  userId: string;
  ok?: boolean;
  detail?: string;
}): Promise<void> {
  await db.insert(commandUsage).values(entry);
}
