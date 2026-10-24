import type { Logger } from 'pino';
import { config } from '../../lib/config.js';
import { createKickProvider } from './kick.js';
import { createTwitchProvider } from './twitch.js';
import { createYoutubeProvider } from './youtube.js';
import type { Platform, PlatformProvider } from '../../lib/counters/platform-types.js';

/** Providers available in this process. A platform without credentials has no provider. */
export function createProviders(log: Logger): Partial<Record<Platform, PlatformProvider>> {
  const providers: Partial<Record<Platform, PlatformProvider>> = {};

  if (config.YOUTUBE_API_KEY) {
    providers.youtube = createYoutubeProvider(config.YOUTUBE_API_KEY);
  } else {
    log.warn('youtube provider off, YOUTUBE_API_KEY missing');
  }

  if (config.TWITCH_CLIENT_ID && config.TWITCH_CLIENT_SECRET) {
    providers.twitch = createTwitchProvider(config.TWITCH_CLIENT_ID, config.TWITCH_CLIENT_SECRET);
  } else {
    log.warn('twitch provider off, TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET missing');
  }

  if (config.KICK_CLIENT_ID && config.KICK_CLIENT_SECRET) {
    providers.kick = createKickProvider(config.KICK_CLIENT_ID, config.KICK_CLIENT_SECRET);
  } else {
    log.warn('kick provider off, KICK_CLIENT_ID or KICK_CLIENT_SECRET missing');
  }

  return providers;
}
