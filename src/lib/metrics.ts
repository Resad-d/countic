import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as promClient from '@prometheus-io/client';
import { selectEnabledPanelCounts } from '../db/queries.js';
import { config } from './config.js';
import { childLogger } from './logger.js';
import { quotaSnapshot } from './quota.js';

/**
 * Prometheus registry for this process.
 * Every process renders its own metrics, the endpoint is internal-only.
 */

const log = childLogger('metrics');

const registry = new promClient.Registry();

// Default process/heap/event-loop metrics, collected on scrape.
promClient.collectDefaultMetrics({ register: registry });

export const panelsUpdated = new promClient.Counter({
  name: 'panels_updated_total',
  help: 'Panel refresh passes that applied numbers',
  labelNames: ['platform'],
  registers: [registry],
});

export const panelUpdateFailures = new promClient.Counter({
  name: 'panel_update_failures_total',
  help: 'Panel refresh passes that produced no update',
  labelNames: ['platform'],
  registers: [registry],
});

export const commandsTotal = new promClient.Counter({
  name: 'commands_total',
  help: 'Slash command invocations',
  labelNames: ['command'],
  registers: [registry],
});

export const guildCount = new promClient.Gauge({
  name: 'guild_count',
  help: 'Guilds cached by this process',
  registers: [registry],
});

new promClient.Gauge({
  name: 'youtube_quota_remaining',
  help: 'YouTube quota units left in each pool today',
  labelNames: ['pool'],
  registers: [registry],
  async collect() {
    try {
      const snapshot = await quotaSnapshot();
      this.set({ pool: 'refresh' }, config.YOUTUBE_REFRESH_POOL - snapshot.refresh);
      this.set({ pool: 'resolution' }, config.YOUTUBE_RESOLUTION_RESERVE - snapshot.resolution);
    } catch {
      // A scrape must not fail over the DB, the last values stay.
    }
  },
});

new promClient.Gauge({
  name: 'panels_enabled',
  help: 'Enabled panels per platform',
  labelNames: ['platform'],
  registers: [registry],
  async collect() {
    try {
      const rows = await selectEnabledPanelCounts();
      for (const row of rows) {
        this.set({ platform: row.platform }, row.enabled);
      }
    } catch {
      // A scrape must not fail over the DB, the last values stay.
    }
  },
});

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export function startMetricsServer(port: number): http.Server {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    renderMetrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      })
      .catch((err) => {
        log.error({ err }, 'failed to render metrics');
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'metrics unavailable' }));
      });
  });
  server.listen(port, () => {
    log.info({ port }, 'metrics listening (internal only)');
  });
  return server;
}
