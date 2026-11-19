import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';
import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';
import { startMetricsServer } from '../lib/metrics.js';
import { pool } from '../db/client.js';
import { createClient } from './client.js';
import { wireEvents } from './events.js';
import { createProviders } from './platforms/index.js';
import { startPresence } from './presence.js';
import { startScheduler } from './scheduler.js';
import { startSweepers } from './sweepers.js';
import { startTransport } from './transport.js';
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
} else if (!process.env.SHARDING_MANAGER && config.SHARD_COUNT !== undefined) {
  // Manager process. djs forks this file again with SHARDING_MANAGER, SHARDS and SHARD_COUNT env set.
  const manager = new ShardingManager(fileURLToPath(import.meta.url), {
    totalShards: config.SHARD_COUNT,
    token: config.DISCORD_TOKEN,
    execArgv: process.execArgv,
    respawn: true,
  });
  manager.on('shardCreate', (shard) => {
    log.info({ shard: shard.id }, 'shard spawned');
    shard.on('death', () => log.info({ shard: shard.id }, 'shard exited'));
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      const kills = Promise.allSettled(manager.shards.map((shard) => shard.kill()));
      const grace = new Promise((resolve) => setTimeout(resolve, 6_500));
      void Promise.race([kills, grace]).then(() => process.exit(0));
    });
  }
  manager
    .spawn()
    .then(() => log.info({ totalShards: config.SHARD_COUNT }, 'all shards ready'))
    .catch((err) => {
      log.error({ err }, 'shard spawn failed');
      process.exit(1);
    });
} else {
  const client = createClient();
  wireEvents(client);
  const providers = createProviders(log);
  wireCommands(client, providers);
  const stopScheduler = startScheduler(client, providers);
  const stopSweepers = startSweepers(client);
  const stopPresence = startPresence(client);
  const metricsServer =
    config.METRICS_ENABLED && (client.shard?.ids.includes(0) ?? true)
      ? startMetricsServer(config.BOT_METRICS_PORT)
      : undefined;
  const transportServer = startTransport(client, providers, config.BOT_TRANSPORT_PORT);

  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'unhandled rejection');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      // Discord socket first, then the pool, so nothing fires mid teardown.
      stopScheduler();
      stopSweepers();
      stopPresence();
      metricsServer?.close();
      transportServer?.close();
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
