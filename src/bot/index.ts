import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';

/**
 * Placeholder entrypoint until the real bot core exists.
 * Idles (with or without a token) so the container stays healthy.
 */

const log = childLogger('bot');

if (config.DISCORD_TOKEN) {
  log.info('DISCORD_TOKEN present. Bot core not built yet. Idling.');
} else {
  log.warn('DISCORD_TOKEN not set. Bot disabled. Idling so the container stays healthy.');
}

// Park the process: an exiting placeholder would restart-loop under
// compose's `restart: unless-stopped`.
const heartbeat = setInterval(() => {
  log.debug({ rss: process.memoryUsage().rss }, 'heartbeat');
}, 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    log.info({ signal }, 'shutting down');
    process.exit(0);
  });
}
