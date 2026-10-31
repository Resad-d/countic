import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';
import { pool } from '../db/client.js';
import { createClient } from './client.js';
import { wireEvents } from './events.js';
import { createProviders } from './platforms/index.js';
import { startScheduler } from './scheduler.js';
import { wireCommands } from './router.js';

/**
 * Bot entrypoint.
 * Connects to Discord when DISCORD_TOKEN is set, otherwise idles so the
 * compose container stays healthy.
 */

const log = childLogger('bot');

if (!config.DISCORD_TOKEN) {
  log.warn('DISCORD_TOKEN not set. Bot disabled. Idling so the container stays healthy.');
  // Park the process, an exit here would restart loop under the compose policy.
  setInterval(() => {
    log.debug({ rss: process.memoryUsage().rss }, 'heartbeat');
  }, 60_000);
} else {
  const client = createClient();
  wireEvents(client);
  const providers = createProviders(log);
  wireCommands(client, providers);
  const stopScheduler = startScheduler(client, providers);

  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'unhandled rejection');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      // Discord socket first, then the pool, so nothing fires mid teardown.
      stopScheduler();
      setTimeout(() => process.exit(0), 5_000).unref();
      void (async () => {
        try {
          await client.destroy();
          await pool.end();
          process.exit(0);
        } catch (err) {
          log.error({ err }, 'shutdown failed');
          process.exit(1);
        }
      })();
    });
  }

  client.login(config.DISCORD_TOKEN).catch((err) => {
    log.error({ err }, 'login failed');
    process.exit(1);
  });
}
