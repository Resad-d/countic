import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';
import { renderMetrics } from '../lib/metrics.js';

/** Minimal web server, no framework yet. */

const log = childLogger('web');

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

const publicServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/healthz') {
    json(res, 200, { status: 'ok' });
    return;
  }
  json(res, 404, { error: 'not found' });
});

publicServer.listen(config.WEB_PORT, () => {
  log.info({ port: config.WEB_PORT }, 'web listening (healthz)');
});

const metricsServer = http.createServer(async (_req, res) => {
  try {
    const body = await renderMetrics();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
  } catch (err) {
    log.error({ err }, 'failed to render metrics');
    json(res, 500, { error: 'metrics unavailable' });
  }
});

if (config.METRICS_ENABLED) {
  metricsServer.listen(config.METRICS_PORT, () => {
    log.info({ port: config.METRICS_PORT }, 'metrics listening (internal only)');
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    publicServer.close(() => process.exit(0));
    metricsServer.close(() => process.exit(0));
    // Fallback if sockets refuse to drain.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
