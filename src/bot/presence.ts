import { ActivityType, Events, type Client, type PresenceData } from 'discord.js';
import { selectEnabledPanelCounts } from '../db/queries.js';
import { formatCount } from '../lib/counters/format.js';
import { childLogger } from '../lib/logger.js';

/**
 * Alternating Watching presence with live counts.
 * Shard 0 computes the label, every shard session applies it so users everywhere see the same.
 */

const log = childLogger('presence');

const SLOT_MS = 5 * 60_000;
const DOMAIN = 'countic.app';

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

// Guild and member totals across shards, local when sharding is off.
async function totals(client: Client): Promise<{ guilds: number; members: number }> {
  if (!client.shard) {
    return {
      guilds: client.guilds.cache.size,
      members: client.guilds.cache.reduce((total, guild) => total + (guild.memberCount ?? 0), 0),
    };
  }
  const shards = await client.shard.broadcastEval<{ guilds: number; members: number }>((c) => ({
    guilds: c.guilds.cache.size,
    members: c.guilds.cache.reduce((total, guild) => total + (guild.memberCount ?? 0), 0),
  }));
  return {
    guilds: shards.reduce((total, shard) => total + shard.guilds, 0),
    members: shards.reduce((total, shard) => total + shard.members, 0),
  };
}

async function brandSlot(): Promise<string> {
  const rows = await selectEnabledPanelCounts();
  const panels = rows.reduce((total, row) => total + row.enabled, 0);
  if (panels === 0) {
    return DOMAIN;
  }
  return `${plural(panels, 'panel')} • ${DOMAIN}`;
}

async function reachSlot(client: Client): Promise<string> {
  const reach = await totals(client);
  if (reach.guilds === 0) {
    return DOMAIN;
  }
  return `${plural(reach.guilds, 'server')} • ${formatCount(reach.members, 'compact', 'en-US')} members`;
}

function presenceFor(label: string): PresenceData {
  return { activities: [{ name: label, type: ActivityType.Watching }] };
}

// The broadcast reaches every shard including 0, the direct set covers no sharding.
async function applyEverywhere(client: Client, presence: PresenceData): Promise<void> {
  if (client.shard) {
    await client.shard.broadcastEval(
      (c, ctx) => {
        c.user?.setPresence(ctx);
        return true;
      },
      { context: presence },
    );
    return;
  }
  client.user?.setPresence(presence);
}

let showBrand = true;

// Applies one slot, then flips to the other for the next tick.
async function rotate(client: Client): Promise<void> {
  let label: string;
  try {
    label = showBrand ? await brandSlot() : await reachSlot(client);
  } catch (err) {
    log.warn({ err }, 'presence refresh failed, keeping the last label');
    return;
  }
  try {
    await applyEverywhere(client, presenceFor(label));
    showBrand = !showBrand;
    log.debug({ label }, 'presence updated');
  } catch (err) {
    log.warn({ err }, 'presence apply failed, the same label retries next tick');
  }
}

// Shard 0 drives the rotation, other shards receive the payload by broadcast.
export function startPresence(client: Client): () => void {
  const shardId = client.shard?.ids[0] ?? 0;
  if (shardId !== 0) {
    return () => {};
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  const onReady = (): void => {
    void rotate(client);
    timer = setInterval(() => void rotate(client), SLOT_MS);
  };
  client.once(Events.ClientReady, onReady);
  return () => {
    client.off(Events.ClientReady, onReady);
    if (timer) {
      clearInterval(timer);
    }
  };
}
