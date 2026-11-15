import { db, pool } from './client.js';
import { commandUsage, counters, guilds, panels } from './schema.js';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Platform } from '../lib/counters/platform-types.js';
import { defaultNumberFormat } from '../lib/counters/templates.js';

/** Panel and bookkeeping queries. */

const num = (value: unknown): number => Number(value ?? 0);

// Insert if missing, ignore if present.
export async function ensureGuild(id: string): Promise<void> {
  await db.insert(guilds).values({ id }).onConflictDoNothing();
}

export async function selectAllGuildIds(): Promise<string[]> {
  const rows = await db.select({ id: guilds.id }).from(guilds);
  return rows.map((row) => row.id);
}

export async function deleteOrphanGuilds(ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const deleted = await db.delete(guilds).where(inArray(guilds.id, ids)).returning({ id: guilds.id });
  return deleted.length;
}

export type DuePanel = {
  id: number;
  guildId: string;
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
      platform: panels.platform,
      sourceId: panels.sourceId,
      sourceName: panels.sourceName,
    })
    .from(panels)
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

export async function selectEnabledCounters(panelIds: number[]): Promise<PanelCounter[]> {
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

export async function deleteOldCommandUsage(retentionDays: number): Promise<number> {
  const deleted = await db
    .delete(commandUsage)
    .where(lte(commandUsage.createdAt, sql`now() - ${retentionDays} * interval '1 day'`))
    .returning({ id: commandUsage.id });
  return deleted.length;
}

export type PanelRow = {
  id: number;
  guildId: string;
  platform: Platform;
  enabled: boolean;
  sourceId: string | null;
  sourceName: string | null;
  reason: string | null;
  lastCheckedAt: Date | null;
  lastStats: Record<string, number> | null;
};

export async function selectPanel(guildId: string, platform: Platform): Promise<PanelRow | null> {
  const rows = await db
    .select({
      id: panels.id,
      guildId: panels.guildId,
      platform: panels.platform,
      enabled: panels.enabled,
      sourceId: panels.sourceId,
      sourceName: panels.sourceName,
      reason: panels.reason,
      lastCheckedAt: panels.lastCheckedAt,
      lastStats: panels.lastStats,
    })
    .from(panels)
    .where(and(eq(panels.guildId, guildId), eq(panels.platform, platform)));
  return rows[0] ?? null;
}

export type NewCounter = { type: string; channelId: string };

// One transaction: guild row, panel row and its counters appear together or not at all.
export async function createPanelRows(input: {
  guildId: string;
  platform: Platform;
  sourceId: string;
  sourceName: string;
  counters: NewCounter[];
  /** Templates and formats carried over from a replaced panel, matched by counter type. */
  carryOver?: Pick<PanelCounterFull, 'type' | 'template' | 'numberFormat'>[];
}): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.insert(guilds).values({ id: input.guildId }).onConflictDoNothing();
    const inserted = await tx
      .insert(panels)
      .values({
        guildId: input.guildId,
        platform: input.platform,
        enabled: true,
        sourceId: input.sourceId,
        sourceName: input.sourceName,
      })
      .returning({ id: panels.id });
    const panelId = inserted[0]?.id;
    if (panelId === undefined) {
      throw new Error('panel insert returned no id');
    }
    if (input.counters.length > 0) {
      await tx.insert(counters).values(
        input.counters.map((counter) => {
          const old = input.carryOver?.find((entry) => entry.type === counter.type);
          return {
            panelId,
            type: counter.type,
            channelId: counter.channelId,
            numberFormat: old?.numberFormat ?? defaultNumberFormat(counter.type),
            template: old?.template ?? null,
          };
        }),
      );
    }
    return panelId;
  });
}

export async function deletePanelRows(panelId: number): Promise<void> {
  await db.delete(panels).where(eq(panels.id, panelId));
}

export async function deleteCounterRow(panelId: number, type: string): Promise<void> {
  await db.delete(counters).where(and(eq(counters.panelId, panelId), eq(counters.type, type)));
}

// Clocks reset so the next tick fetches fresh numbers for the new source.
export async function updatePanelSource(panelId: number, sourceId: string, sourceName: string): Promise<void> {
  await db
    .update(panels)
    .set({ sourceId, sourceName, lastCheckedAt: null, lastStats: null, updatedAt: sql`now()` })
    .where(eq(panels.id, panelId));
}

// Clocks stay, the sweep that fetched this name already marked the panel.
export async function updatePanelSourceName(panelId: number, sourceName: string): Promise<void> {
  await db
    .update(panels)
    .set({ sourceName, updatedAt: sql`now()` })
    .where(eq(panels.id, panelId));
}

export type PanelCounterFull = PanelCounter & { reason: string | null };

export async function selectCountersWithReasons(panelIds: number[]): Promise<PanelCounterFull[]> {
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
      reason: counters.reason,
    })
    .from(counters)
    .where(inArray(counters.panelId, panelIds));
}

export type CounterRow = PanelCounter & { platform: Platform; guildId: string };

export async function selectCounterById(counterId: number): Promise<CounterRow | null> {
  const rows = await db
    .select({
      id: counters.id,
      panelId: counters.panelId,
      type: counters.type,
      channelId: counters.channelId,
      enabled: counters.enabled,
      numberFormat: counters.numberFormat,
      template: counters.template,
      platform: panels.platform,
      guildId: panels.guildId,
    })
    .from(counters)
    .innerJoin(panels, eq(panels.id, counters.panelId))
    .where(eq(counters.id, counterId));
  return rows[0] ?? null;
}

export async function setCounterTemplate(counterId: number, template: string | null): Promise<void> {
  await db.update(counters).set({ template }).where(eq(counters.id, counterId));
}

export async function setCounterFormat(counterId: number, numberFormat: 'compact' | 'full'): Promise<void> {
  await db.update(counters).set({ numberFormat }).where(eq(counters.id, counterId));
}

export async function setCounterEnabled(counterId: number, enabled: boolean): Promise<void> {
  await db.update(counters).set({ enabled }).where(eq(counters.id, counterId));
}

/**
 * Successful setup and set-channel runs in this pacific day for one guild.
 * Failed and denied attempts spent nothing, so they never count.
 */
export async function resolutionSpentToday(guildId: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*) as spent from command_usage
    where guild_id = ${guildId}
      and ok = true
      and command in ('setup', 'set-channel')
      and created_at >= date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
  `);
  const row = result.rows[0] as { spent?: string | number } | undefined;
  return Number(row?.spent ?? 0);
}

export type AdminStats = {
  guilds: number;
  panels: { platform: Platform; total: number; enabled: number }[];
  counters: { type: string; total: number; enabled: number }[];
  usage: { command: string; uses: number; failed: number }[];
};

// Counts for the admin view.
export async function selectAdminStats(): Promise<AdminStats> {
  const [guilds, panels, counters, usage] = await Promise.all([
    db.execute(sql`select count(*) as total from guilds`),
    db.execute(sql`
      select platform, count(*) as total, count(*) filter (where enabled) as enabled
      from panels group by platform order by platform
    `),
    db.execute(sql`
      select type, count(*) as total, count(*) filter (where enabled) as enabled
      from counters group by type order by type
    `),
    db.execute(sql`
      select command, count(*) as uses, count(*) filter (where ok = false) as failed
      from command_usage
      where created_at > now() - interval '24 hours'
      group by command order by uses desc
    `),
  ]);
  return {
    guilds: num((guilds.rows[0] as { total?: string } | undefined)?.total),
    panels: (panels.rows as { platform: string; total: string; enabled: string }[]).map((row) => ({
      platform: row.platform as Platform,
      total: num(row.total),
      enabled: num(row.enabled),
    })),
    counters: (counters.rows as { type: string; total: string; enabled: string }[]).map((row) => ({
      type: row.type,
      total: num(row.total),
      enabled: num(row.enabled),
    })),
    usage: (usage.rows as { command: string; uses: string; failed: string }[]).map((row) => ({
      command: row.command,
      uses: num(row.uses),
      failed: num(row.failed),
    })),
  };
}

export async function selectEnabledPanelCounts(): Promise<{ platform: Platform; enabled: number }[]> {
  const result = await db.execute(sql`
    select platform, count(*) filter (where enabled) as enabled
    from panels group by platform
  `);
  return (result.rows as { platform: string; enabled: string }[]).map((row) => ({
    platform: row.platform as Platform,
    enabled: num(row.enabled),
  }));
}

export type AdminSqlResult = {
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
};

/**
 * One statement under a read only transaction with a 5s timeout.
 * The finally path clears an aborted transaction before the pool reuses the connection.
 */
export async function adminSql(query: string): Promise<AdminSqlResult> {
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query('begin transaction read only');
    await client.query("set local statement_timeout = '5s'");
    const result = await client.query(query);
    await client.query('rollback');
    finished = true;
    return {
      fields: result.fields.map((field) => field.name),
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  } finally {
    if (!finished) {
      await client.query('rollback').catch(() => {});
    }
    client.release();
  }
}
