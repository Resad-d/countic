import http from 'node:http';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { z } from 'zod';
import { createPanelChannels, deleteChannelsBestEffort, teardownPanel, type CreatedCounter } from './panels.js';
import { createPanelRows, selectPanel } from '../db/queries.js';
import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';

/**
 * Internal HTTP server for the web process.
 * Compose network only, secret-header auth.
 */

const log = childLogger('transport');

const SNOWFLAKE = z.string().regex(/^\d{17,20}$/);
const PLATFORMS = z.enum(['youtube', 'twitch', 'kick']);

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    guildId: SNOWFLAKE,
    platform: PLATFORMS,
    sourceId: z.string().min(1).max(64),
    sourceName: z.string().min(1).max(100),
    carryOver: z
      .array(
        z.object({
          type: z.string(),
          template: z.string().nullable(),
          numberFormat: z.enum(['compact', 'full']),
        }),
      )
      .max(8)
      .optional(),
  }),
  z.object({
    action: z.literal('teardown'),
    guildId: SNOWFLAKE,
    platform: PLATFORMS,
  }),
]);

function authorized(req: IncomingMessage): boolean {
  const secret = config.TRANSPORT_SECRET;
  const provided = req.headers['x-transport-secret'];
  if (!secret || typeof provided !== 'string') {
    return false;
  }
  // Hashing first fixes both lengths, so timingSafeEqual cannot leak either side.
  const left = crypto.createHash('sha256').update(provided).digest();
  const right = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(left, right);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 16384): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function resolveGuild(client: Client, guildId: string): Promise<Guild | null> {
  return client.guilds.fetch(guildId).catch(() => null);
}

function shardIdForGuild(guildId: string, shardCount: number): number {
  return Number((BigInt(guildId) >> 22n) % BigInt(shardCount));
}

async function checkManageGuild(client: Client, guildId: string, userId: string): Promise<boolean> {
  try {
    if (!client.shard) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return false;
      }
      const member = await guild.members.fetch(userId).catch(() => null);
      return member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;
    }
    const allowed = (await client.shard.broadcastEval(
      (c, ctx) => {
        const guild = c.guilds.cache.get(ctx.guildId);
        if (!guild) {
          return false;
        }
        return guild.members
          .fetch(ctx.userId)
          .then((member) => member.permissions.has(BigInt(ctx.manageGuild)))
          .catch(() => false);
      },
      {
        context: { guildId, userId, manageGuild: Number(PermissionFlagsBits.ManageGuild) },
        shard: shardIdForGuild(guildId, client.shard.count),
      },
    )) === true;
    return allowed;
  } catch (err) {
    log.warn({ err, guildId }, 'permission check failed, failing closed');
    return false;
  }
}

async function handleMutation(client: Client, body: unknown): Promise<{ status: number; payload: unknown }> {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, payload: { error: parsed.error.issues[0]?.message ?? 'invalid body' } };
  }
  const input = parsed.data;
  if (input.action === 'teardown') {
    const panel = await selectPanel(input.guildId, input.platform);
    if (!panel) {
      return { status: 404, payload: { error: 'panel not found' } };
    }
    const guild = await resolveGuild(client, input.guildId);
    if (!guild) {
      return { status: 404, payload: { error: 'guild not found' } };
    }
    return { status: 200, payload: await teardownPanel(guild, panel) };
  }
  const existing = await selectPanel(input.guildId, input.platform);
  if (existing) {
    // The caller decides between keep and replace, mirroring the setup confirm flow.
    return { status: 409, payload: { error: 'panel already exists', panelId: existing.id } };
  }
  const guild = await resolveGuild(client, input.guildId);
  if (!guild) {
    return { status: 404, payload: { error: 'guild not found' } };
  }
  let created: CreatedCounter[];
  try {
    created = await createPanelChannels(guild, input.platform, input.sourceName);
  } catch (err) {
    log.warn({ err, guildId: input.guildId }, 'discord rejected channel creation');
    return { status: 502, payload: { error: 'discord rejected channel creation' } };
  }
  try {
    const panelId = await createPanelRows({
      guildId: input.guildId,
      platform: input.platform,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      counters: created.map((counter) => ({ type: counter.type, channelId: counter.channelId })),
      carryOver: input.carryOver,
    });
    return { status: 201, payload: { panelId, counters: created } };
  } catch (err) {
    log.error({ err, guildId: input.guildId }, 'panel rows failed, rolling back channels');
    await deleteChannelsBestEffort(guild, created);
    return { status: 500, payload: { error: 'panel rows failed' } };
  }
}

async function route(client: Client, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://transport.local');
  if (req.method === 'POST' && url.pathname === '/panels') {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      send(res, 413, { error: 'body too large' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      send(res, 400, { error: 'invalid json' });
      return;
    }
    const result = await handleMutation(client, body);
    send(res, result.status, result.payload);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/permissions') {
    const guildId = url.searchParams.get('guildId') ?? '';
    const userId = url.searchParams.get('userId') ?? '';
    if (!SNOWFLAKE.safeParse(guildId).success || !SNOWFLAKE.safeParse(userId).success) {
      send(res, 400, { error: 'guildId and userId are required snowflakes' });
      return;
    }
    send(res, 200, { allowed: await checkManageGuild(client, guildId, userId) });
    return;
  }
  send(res, 404, { error: 'not found' });
}

async function handle(client: Client, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    log.warn({ ip: req.socket.remoteAddress, path: req.url }, 'transport auth failed');
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!client.isReady()) {
    send(res, 503, { error: 'bot is starting up' });
    return;
  }
  await route(client, req, res);
}

export function startTransport(client: Client, port: number): http.Server | undefined {
  if (!config.TRANSPORT_SECRET) {
    log.warn('TRANSPORT_SECRET not set. Transport disabled.');
    return undefined;
  }
  if (client.shard && !client.shard.ids.includes(0)) {
    log.info({ ids: client.shard.ids.join(',') }, 'transport lives on shard 0');
    return undefined;
  }
  const server = http.createServer((req, res) => {
    handle(client, req, res).catch((err) => {
      log.error({ err }, 'transport handler crashed');
      send(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, () => {
    log.info({ port }, 'transport listening (compose network only)');
  });
  return server;
}
