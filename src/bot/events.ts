import { Events, type Client } from 'discord.js';
import { ensureGuild } from '../db/queries.js';
import { childLogger } from '../lib/logger.js';
import { guildCount } from '../lib/metrics.js';

/** Gateway event handlers. */

const log = childLogger('events');

export function wireEvents(client: Client): void {
  client.once(Events.ClientReady, (ready) => {
    log.info(
      { user: ready.user.tag, shard: ready.shard?.ids ?? [], guilds: ready.guilds.cache.size },
      'bot ready',
    );
    guildCount.set(ready.guilds.cache.size);
  });

  client.on(Events.GuildCreate, (guild) => {
    log.info(
      { evt: 'guildJoin', guildId: guild.id, name: guild.name, memberCount: guild.memberCount, shard: guild.shardId },
      'guild joined',
    );
    guildCount.inc();
    void ensureGuild(guild.id);
  });

  client.on(Events.GuildDelete, (guild) => {
    log.info(
      { evt: 'guildLeave', guildId: guild.id, name: guild.name, memberCount: guild.memberCount, shard: guild.shardId },
      'guild left',
    );
    guildCount.dec();
  });
}
