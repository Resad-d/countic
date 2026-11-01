import type { Client } from 'discord.js';
import { deleteOldCommandUsage, deleteOrphanGuilds, selectAllGuildIds } from '../db/queries.js';
import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';

/** Shard 0 bookkeeping sweeps. */

const log = childLogger('sweeper');

// A sweep that would remove most of the table means a token or cache problem, not real departures.
const MAX_ORPHAN_FRACTION = 0.5;

export async function runOrphanSweep(client: Client): Promise<void> {
  try {
    const shardId = client.shard?.ids[0] ?? 0;
    if (shardId !== 0) {
      return;
    }
    if (!client.isReady()) {
      log.info('orphan sweep skipped, client not ready');
      return;
    }
    if (client.shard) {
      const ready = await client.shard.broadcastEval((c) => c.isReady());
      if (ready.some((r) => !r)) {
        log.info('orphan sweep skipped, not all shards ready');
        return;
      }
    }
    const liveIds = client.shard
      ? new Set((await client.shard.broadcastEval((c) => [...c.guilds.cache.keys()])).flat())
      : new Set(client.guilds.cache.keys());
    const dbIds = await selectAllGuildIds();
    const orphans = dbIds.filter((id) => !liveIds.has(id));
    if (dbIds.length > 0 && orphans.length / dbIds.length > MAX_ORPHAN_FRACTION) {
      log.warn(
        { dbGuilds: dbIds.length, orphans: orphans.length },
        'orphan sweep aborted, deletion would exceed the safety fraction',
      );
      return;
    }
    const removed = await deleteOrphanGuilds(orphans);
    log.info({ evt: 'orphanSweep', checked: dbIds.length, removed }, 'orphan sweep complete');
  } catch (err) {
    log.error({ err }, 'orphan sweep failed');
  }
}

export async function runRetentionSweep(): Promise<void> {
  try {
    const removed = await deleteOldCommandUsage(config.COMMAND_LOG_RETENTION_DAYS);
    log.info({ evt: 'retentionSweep', removed }, 'command usage retention complete');
  } catch (err) {
    log.error({ err }, 'retention sweep failed');
  }
}

// First orphan run 5 minutes after boot, then weekly, retention daily.
export function startSweepers(client: Client): () => void {
  const shardId = client.shard?.ids[0] ?? 0;
  if (shardId !== 0) {
    return () => {};
  }
  const firstOrphan = setTimeout(() => void runOrphanSweep(client), 5 * 60_000);
  const weeklyOrphan = setInterval(() => void runOrphanSweep(client), 7 * 24 * 60 * 60_000);
  const dailyRetention = setInterval(() => void runRetentionSweep(), 24 * 60 * 60_000);
  return () => {
    clearTimeout(firstOrphan);
    clearInterval(weeklyOrphan);
    clearInterval(dailyRetention);
  };
}
