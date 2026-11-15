import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
} from 'discord.js';
import { deletePanelRows, selectCountersWithReasons, type PanelRow } from '../db/queries.js';
import { counterName } from '../lib/counters/names.js';
import type { Platform } from '../lib/counters/platform-types.js';
import { DEFAULT_TEMPLATES, defaultNumberFormat } from '../lib/counters/templates.js';
import { childLogger } from '../lib/logger.js';

/** Discord side of the panel lifecycle: channel creation, teardown and permission checks. */

const log = childLogger('panels');

export type CreatedCounter = { type: string; channelId: string; name: string };

/**
 * Create the category and its counter voice channels, placeholders until the first update.
 * Throws on the first failure, channels created before the failure are deleted.
 */
export async function createPanelChannels(guild: Guild, platform: Platform, sourceName: string): Promise<CreatedCounter[]> {
  // Number decimals follow the server language.
  const locale = guild.preferredLocale ?? 'en';
  const categoryInput = { type: 'category', template: null, numberFormat: defaultNumberFormat('category') };
  const categoryName = counterName(categoryInput, platform, { sourceName, values: {} }, locale) ?? 'category';
  const created: CreatedCounter[] = [];
  try {
    const category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
    created.push({ type: 'category', channelId: category.id, name: categoryName });
    const defaults = DEFAULT_TEMPLATES[platform] as Partial<Record<string, string>>;
    for (const type of Object.keys(defaults)) {
      if (type === 'category') {
        continue;
      }
      const input = { type, template: null, numberFormat: defaultNumberFormat(type) };
      const name = counterName(input, platform, null, locale) ?? type;
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      created.push({ type, channelId: channel.id, name });
    }
    await category.setPosition(0).catch(() => {});
    return created;
  } catch (err) {
    await deleteChannelsBestEffort(guild, created);
    throw err;
  }
}

/**
 * Delete panel channels by counter rows, children before the category.
 * Cache first, REST fetch on miss. Returns how many could not be deleted.
 */
export async function deleteChannelsBestEffort(guild: Guild, counters: { type: string; channelId: string }[]): Promise<number> {
  const children = counters.filter((counter) => counter.type !== 'category').map((counter) => counter.channelId);
  const parents = counters.filter((counter) => counter.type === 'category').map((counter) => counter.channelId);
  let failed = 0;
  for (const id of [...children, ...parents]) {
    try {
      const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id));
      if (channel) {
        await channel.delete();
      }
    } catch (err) {
      if (err instanceof DiscordAPIError && Number(err.code) === RESTJSONErrorCodes.UnknownChannel) {
        continue;
      }
      log.warn({ err, channelId: id }, 'channel delete failed');
      failed++;
    }
  }
  return failed;
}

export function canManageChannels(guild: Guild): boolean {
  return guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false;
}

/**
 * Delete a panel's channels, children before the category, then its DB rows.
 * Returns the counter count and how many channels survived.
 */
export async function teardownPanel(
  guild: Guild,
  panelRow: PanelRow,
): Promise<{ counterCount: number; leftover: number }> {
  const counters = await selectCountersWithReasons([panelRow.id]);
  const leftover = await deleteChannelsBestEffort(guild, counters);
  await deletePanelRows(panelRow.id);
  return { counterCount: counters.length, leftover };
}
