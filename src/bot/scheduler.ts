import type { Channel, Client } from 'discord.js';
import { CategoryChannel, DiscordAPIError, RESTJSONErrorCodes, VoiceChannel } from 'discord.js';
import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';
import { panelUpdateFailures, panelsUpdated } from '../lib/metrics.js';
import { cadenceStretch, clampToPool, spend } from '../lib/quota.js';
import { counterName } from '../lib/counters/names.js';
import { PlatformError } from '../lib/counters/platform-types.js';
import { PLATFORMS } from '../lib/counters/platform-types.js';
import type { FetchResult, Platform, PlatformProvider, Stats } from '../lib/counters/platform-types.js';
import type { DuePanel, PanelCounter } from '../db/queries.js';
import {
  disableCounter,
  disablePanel,
  markChecked,
  markCheckedWithStats,
  selectEnabledCounters,
  selectDuePanels,
  updatePanelSourceName,
} from '../db/queries.js';

/**
 * Periodic panel refresh.
 * One tick selects due panels for this shard, batches the source fetches and
 * renames only counters whose rendered name actually changed.
 */

const log = childLogger('scheduler');

const YT_BATCH = 50;

// Discord rename failures that will never succeed again, everything else retries next tick.
const PERMANENT_CODES = new Set<number>([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.MissingAccess,
]);

const CADENCE: Record<Platform, number> = {
  youtube: config.YOUTUBE_REFRESH_CADENCE_MINUTES,
  twitch: config.TWITCH_REFRESH_CADENCE_MINUTES,
  kick: config.KICK_REFRESH_CADENCE_MINUTES,
};

// Group items into arrays under a shared key.
function groupBy<T, K extends string | number>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

async function renameCounter(counter: PanelCounter, name: string, client: Client): Promise<boolean> {
  // Cache first, fetch only on a cache miss so sweeps stay off the REST API.
  let channel: Channel | null | undefined = client.channels.cache.get(counter.channelId);
  if (!channel) {
    try {
      channel = await client.channels.fetch(counter.channelId);
    } catch (err) {
      // An outage must not look like a deleted channel, only a definitive unknown channel does.
      if (!(err instanceof DiscordAPIError && Number(err.code) === (RESTJSONErrorCodes.UnknownChannel as number))) {
        throw err;
      }
    }
    if (!channel) {
      await disableCounter(counter.id, 'channel not found');
      return false;
    }
  }
  if (!(channel instanceof VoiceChannel) && !(channel instanceof CategoryChannel)) {
    await disableCounter(counter.id, 'channel is not a voice channel');
    return false;
  }
  if (channel.name === name) {
    return true;
  }
  try {
    await channel.setName(name);
    return true;
  } catch (err) {
    if (err instanceof DiscordAPIError && PERMANENT_CODES.has(Number(err.code))) {
      await disableCounter(counter.id, err.message);
      return false;
    }
    throw err;
  }
}

async function updatePanel(
  panel: DuePanel,
  stats: Stats,
  counters: PanelCounter[],
  client: Client,
): Promise<boolean> {
  let failed = 0;
  // Number decimals follow the server language.
  const locale = client.guilds.cache.get(panel.guildId)?.preferredLocale ?? 'en';
  for (const counter of counters) {
    const name = counterName(counter, panel.platform, stats, locale);
    if (name === null) {
      continue;
    }
    const ok = await renameCounter(counter, name, client);
    if (!ok) {
      failed++;
    }
  }
  if (counters.length > 0 && failed === counters.length) {
    await disablePanel(panel.id, 'no counter could be updated');
    return false;
  }
  await markCheckedWithStats(panel.id, stats.values);
  return true;
}

export function startScheduler(client: Client, providers: Partial<Record<Platform, PlatformProvider>>): () => void {
  const shardId = client.shard?.ids[0] ?? 0;
  const shardCount = client.options.shardCount ?? 1;

  async function tick(): Promise<void> {
    let budget = config.SCHEDULER_MAX_PANELS_PER_TICK;
    for (const platform of PLATFORMS) {
      const provider = providers[platform];
      if (!provider || budget <= 0) {
        continue;
      }
      try {
        // Elastic cadence: over pace stretches the youtube cooldown instead of exhausting the pool.
        let cadence = CADENCE[platform];
        if (platform === 'youtube') {
          cadence = Math.round(cadence * (await cadenceStretch('refresh')));
        }
        const due = await selectDuePanels(platform, cadence, shardId, shardCount, budget);
        if (due.length === 0) {
          continue;
        }
        budget -= due.length;

        const bySource = groupBy(due, (panel) => panel.sourceId);
        const sourceIds = [...bySource.keys()];

        if (platform === 'youtube' && !(await spend('channels_list', 'refresh', Math.ceil(sourceIds.length / YT_BATCH)))) {
          log.debug('youtube refresh deferred, quota pool exhausted');
          continue;
        }

        let results: Map<string, FetchResult>;
        try {
          results = await provider.fetchStats(sourceIds);
        } catch (err) {
          if (err instanceof PlatformError) {
            if (err.failure === 'quota') {
              await clampToPool();
            } else if (err.failure === 'permanent') {
              for (const panel of due) {
                await disablePanel(panel.id, err.message);
              }
            }
          }
          // Transient fetch errors retry on the next tick, so panels stay due.
          panelUpdateFailures.inc({ platform }, due.length);
          log.warn({ err, platform, sources: sourceIds.length }, 'source fetch failed');
          continue;
        }

        const counters = await selectEnabledCounters(due.map((panel) => panel.id));
        const byPanel = groupBy(counters, (counter) => counter.panelId);

        for (const panel of due) {
          const result = results.get(panel.sourceId);
          if (!result) {
            await markChecked(panel.id);
            continue;
          }
          if ('failure' in result) {
            panelUpdateFailures.inc({ platform });
            if (result.failure === 'permanent') {
              await disablePanel(panel.id, result.message);
            } else if (result.failure !== 'transient') {
              await markChecked(panel.id);
            }
            continue;
          }
          if (result.sourceName !== panel.sourceName) {
            await updatePanelSourceName(panel.id, result.sourceName);
            panel.sourceName = result.sourceName;
          }
          try {
            const ok = await updatePanel(panel, result, byPanel.get(panel.id) ?? [], client);
            if (ok) {
              panelsUpdated.inc({ platform });
            } else {
              panelUpdateFailures.inc({ platform });
            }
          } catch (err) {
            // Transient rename errors retry on the next tick, so the panel stays due.
            panelUpdateFailures.inc({ platform });
            log.warn({ err, panelId: panel.id }, 'panel update failed');
          }
        }
      } catch (err) {
        log.error({ err, platform }, 'scheduler tick failed');
      }
    }
  }

  // Small jitter so shards do not fire their API calls at the same instant.
  const jitter = Math.random() * 30_000;
  let interval: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), config.SCHEDULER_TICK_SECONDS * 1000);
  }, jitter);

  return () => {
    clearTimeout(timer);
    clearInterval(interval);
  };
}
