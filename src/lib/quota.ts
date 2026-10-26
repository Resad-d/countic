import { db } from '../db/client.js';
import { config } from './config.js';
import { childLogger } from './logger.js';
import { sql } from 'drizzle-orm';

/** YouTube quota meter backed by the meta table, one row per pacific day. */

export type QuotaClass = 'refresh' | 'resolution';

// Anything not listed here is refused, fail closed.
const COSTS = {
  channels_list: 1,
} as const satisfies Record<string, number>;

export type QuotaEndpoint = keyof typeof COSTS;

const log = childLogger('quota');

// Google resets quota at midnight pacific time, so our day must match, not UTC.
const PT = 'America/Los_Angeles';
const ptDate = new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' });
const ptTime = new Intl.DateTimeFormat('en-US', {
  timeZone: PT,
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function dayKey(): string {
  return `yt_quota_${ptDate.format(new Date())}`;
}

// Hours since pacific midnight, how far into the google quota window we are.
function dayElapsedHours(): number {
  const [hours, minutes, seconds] = ptTime.format(new Date()).split(':').map(Number);
  return (hours % 24) + minutes / 60 + seconds / 3600;
}

/**
 * Try to spend units of an endpoint cost from one pool.
 * Returns false when the pool is exhausted, the caller must defer the work.
 */
export async function spend(endpoint: QuotaEndpoint, quotaClass: QuotaClass, calls = 1): Promise<boolean> {
  const units = COSTS[endpoint] * calls;
  const key = dayKey();
  const pool = quotaClass === 'refresh' ? config.YOUTUBE_REFRESH_POOL : config.YOUTUBE_RESOLUTION_RESERVE;

  await db.execute(sql`
    insert into meta (key, value, updated_at)
    values (${key}, jsonb_build_object('refresh', 0, 'resolution', 0), now())
    on conflict (key) do update set updated_at = now()
  `);

  const applied = await db.execute(sql`
    update meta
    set value = jsonb_set(
      value,
      ${sql.raw(`'{${quotaClass}}'`)}::text[],
      to_jsonb((value ->> ${quotaClass})::bigint + ${units})
    ),
    updated_at = now()
    where key = ${key}
      and (value ->> ${quotaClass})::bigint + ${units} <= ${pool}
    returning value ->> ${quotaClass} as spent
  `);
  if (applied.rowCount === 0) {
    log.debug({ day: key, quotaClass, units, pool }, 'quota pool exhausted');
    return false;
  }
  return true;
}

/**
 * Elastic cadence multiplier for the refresh pool.
 * Projected day spend = pace so far stretched to 24 hours, over pool means stretch by the ratio.
 * Capped at 10 so one heavy sweep cannot stall the whole day.
 */
export async function cadenceStretch(quotaClass: QuotaClass): Promise<number> {
  const result = await db.execute(sql`select value from meta where key = ${dayKey()}`);
  const spent = Number((result.rows[0] as { value?: Record<string, number> } | undefined)?.value?.[quotaClass] ?? 0);
  const hours = Math.max(dayElapsedHours(), 1);
  const pool = quotaClass === 'refresh' ? config.YOUTUBE_REFRESH_POOL : config.YOUTUBE_RESOLUTION_RESERVE;
  const projected = (spent / hours) * 24;
  return projected > pool ? Math.min(projected / pool, 10) : 1;
}

/**
 * A real quotaExceeded 403 means the whole google project is out, refresh and resolution alike.
 * Clamp both pools so every further spend refuses until the day rolls over.
 */
export async function clampToPool(): Promise<void> {
  const key = dayKey();
  await db.execute(sql`
    update meta
    set value = jsonb_build_object(
      'refresh', ${config.YOUTUBE_REFRESH_POOL},
      'resolution', ${config.YOUTUBE_RESOLUTION_RESERVE}
    ),
    updated_at = now()
    where key = ${key}
  `);
  log.warn({ day: key }, 'quota exceeded reported by youtube, all spends paused until pacific midnight');
}
