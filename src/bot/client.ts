import { Client, GatewayIntentBits, Options } from 'discord.js';

/** Discord client factory. */

export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      // Managers the bot never reads. Dropping them keeps RAM flat.
      AutoModerationRuleManager: 0,
      GuildBanManager: 0,
      GuildInviteManager: 0,
      GuildScheduledEventManager: 0,
      GuildStickerManager: 0,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      StageInstanceManager: 0,
      VoiceStateManager: 0,
      GuildMemberManager: 5,
    }),
  });
}
