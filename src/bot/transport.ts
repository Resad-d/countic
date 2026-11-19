import http from 'node:http';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { z } from 'zod';
import { createPanelChannels, deleteChannelsBestEffort, teardownPanel, type CreatedCounter } from './panels.js';
import {
  createPanelRows,
  deleteCounterRowById,
  selectCounterById,
  selectCountersWithReasons,
  selectPanel,
  setCounterSettings,
  updatePanelSource,
} from '../db/queries.js';
import { classify } from '../lib/counters/classify.js';
import {
  PlatformError,
  type FailureKind,
  type Platform,
  type PlatformProvider,
} from '../lib/counters/platform-types.js';
import { DEFAULT_TEMPLATES, validateTemplate } from '../lib/counters/templates.js';
import { resolutionAllowed, spend } from '../lib/quota.js';
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
  z.object({
    action: z.literal('counter-save'),
    guildId: SNOWFLAKE,
    platform: PLATFORMS,
    counterId: z.number().int().positive(),
    template: z.string().max(100).nullable(),
    numberFormat: z.enum(['compact', 'full']),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal('source'),
    guildId: SNOWFLAKE,
    platform: PLATFORMS,
    sourceId: z.string().min(1).max(64),
    sourceName: z.string().min(1).max(100),
  }),
  z.object({
    action: z.literal('counter-delete'),
    guildId: SNOWFLAKE,
    platform: PLATFORMS,
    counterId: z.number().int().positive(),
  }),
]);

const resolveSchema = z.object({
  guildId: SNOWFLAKE,
  platform: PLATFORMS,
  query: z.string().trim().min(1).max(100),
});

type Providers = Partial<Record<Platform, PlatformProvider>>;

type CounterAction = Extract<z.infer<typeof bodySchema>, { action: 'counter-save' }>;

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

async function checkManageChannels(client: Client, guildId: string, userId: string): Promise<boolean> {
  try {
    if (!client.shard) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return false;
      }
      const member = await guild.members.fetch(userId).catch(() => null);
      return member?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false;
    }
    const allowed = (await client.shard.broadcastEval(
      (c, ctx) => {
        const guild = c.guilds.cache.get(ctx.guildId);
        if (!guild) {
          return false;
        }
        return guild.members
          .fetch(ctx.userId)
          .then((member) => member.permissions.has(BigInt(ctx.manageChannels)))
          .catch(() => false);
      },
      {
        context: { guildId, userId, manageChannels: Number(PermissionFlagsBits.ManageChannels) },
        shard: shardIdForGuild(guildId, client.shard.count),
      },
    )) === true;
    return allowed;
  } catch (err) {
    log.warn({ err, guildId }, 'permission check failed, failing closed');
    return false;
  }
}

async function channelsPresent(client: Client, guildId: string, channelIds: string[]): Promise<boolean> {
  try {
    if (!client.shard) {
      const guild = client.guilds.cache.get(guildId);
      return Boolean(guild) && channelIds.every((id) => guild?.channels.cache.has(id));
    }
    const present = (await client.shard.broadcastEval(
      (c, ctx) => {
        const guild = c.guilds.cache.get(ctx.guildId);
        return Boolean(guild) && ctx.ids.every((id) => guild?.channels.cache.has(id));
      },
      {
        context: { guildId, ids: channelIds },
        shard: shardIdForGuild(guildId, client.shard.count),
      },
    )) === true;
    return present;
  } catch (err) {
    log.warn({ err, guildId }, 'channel presence check failed');
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
  if (input.action === 'source') {
    const panel = await selectPanel(input.guildId, input.platform);
    if (!panel) {
      return { status: 404, payload: { error: 'panel not found' } };
    }
    // Channels stay, the clock reset makes the next tick rename them for the new source.
    await updatePanelSource(panel.id, input.sourceId, input.sourceName);
    return { status: 200, payload: { ok: true } };
  }
  if (input.action === 'counter-delete') {
    const row = await selectCounterById(input.counterId);
    if (!row || row.guildId !== input.guildId || row.platform !== input.platform) {
      return { status: 404, payload: { error: 'counter not found' } };
    }
    const guild = await resolveGuild(client, input.guildId);
    if (!guild) {
      return { status: 404, payload: { error: 'guild not found' } };
    }
    const leftover = await deleteChannelsBestEffort(guild, [{ type: row.type, channelId: row.channelId }]);
    await deleteCounterRowById(row.id);
    return { status: 200, payload: { deleted: true, leftover } };
  }
  if (input.action !== 'create') {
    return handleCounterAction(client, input);
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

async function handleCounterAction(client: Client, input: CounterAction): Promise<{ status: number; payload: unknown }> {
  const row = await selectCounterById(input.counterId);
  if (!row || row.guildId !== input.guildId || row.platform !== input.platform) {
    return { status: 404, payload: { error: 'counter not found' } };
  }
  // The category shows no number, browsers submit its unchanged format.
  if (row.type === 'category' && input.numberFormat !== row.numberFormat) {
    return { status: 400, payload: { error: 'category has no format' } };
  }
  const guild = client.guilds.cache.get(input.guildId) ?? (await resolveGuild(client, input.guildId));
  const candidate = input.template === null ? '' : input.template.trim();
  const check = validateTemplate(row.platform, row.type, candidate, input.numberFormat, guild?.preferredLocale ?? 'en');
  if (!check.ok) {
    return { status: 400, payload: { error: check.code, placeholder: check.placeholder, length: check.length } };
  }
  await setCounterSettings(row.id, {
    template: check.template,
    numberFormat: input.numberFormat,
    enabled: input.enabled,
  });
  return { status: 200, payload: { ok: true } };
}

async function handleList(client: Client, guildId: string): Promise<{ status: number; payload: unknown }> {
  const guild = await resolveGuild(client, guildId);
  if (!guild) {
    return { status: 404, payload: { error: 'guild not found' } };
  }
  const rows = await Promise.all(PLATFORMS.options.map((platform) => selectPanel(guildId, platform)));
  const found = rows.filter((row) => row !== null);
  const counters = await selectCountersWithReasons(found.map((row) => row.id));
  const panels = found.map((row) => ({
    platform: row.platform,
    enabled: row.enabled,
    reason: row.reason,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    lastCheckedAt: row.lastCheckedAt,
    lastStats: row.lastStats,
    counters: counters.filter((counter) => counter.panelId === row.id),
  }));
  return { status: 200, payload: { guildId, locale: guild.preferredLocale ?? 'en', panels } };
}

function resolveFailure(failure: FailureKind | 'not-found' | 'invalid'): { status: number; payload: unknown } {
  if (failure === 'quota') {
    return { status: 429, payload: { error: 'quota exhausted' } };
  }
  if (failure === 'transient') {
    return { status: 502, payload: { error: 'source fetch failed' } };
  }
  if (failure === 'not-found') {
    return { status: 404, payload: { error: 'source not found' } };
  }
  return { status: 400, payload: { error: 'invalid source' } };
}

async function handleResolve(
  client: Client,
  providers: Providers,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, payload: { error: parsed.error.issues[0]?.message ?? 'invalid body' } };
  }
  const { guildId, platform, query } = parsed.data;
  const provider = providers[platform];
  if (!provider) {
    return { status: 501, payload: { error: 'platform unavailable' } };
  }
  const guild = await resolveGuild(client, guildId);
  if (!guild) {
    return { status: 404, payload: { error: 'guild not found' } };
  }
  const classified = classify(platform, query);
  if (!classified) {
    return { status: 400, payload: { error: 'invalid source' } };
  }
  if (!(await resolutionAllowed(guildId))) {
    return { status: 429, payload: { error: 'resolution cap reached' } };
  }
  // Only youtube draws from the quota meter, twitch and kick are free.
  if (platform === 'youtube' && !(await spend('channels_list', 'resolution', 1))) {
    return { status: 429, payload: { error: 'quota exhausted' } };
  }
  let resolved: Awaited<ReturnType<PlatformProvider['resolveSource']>>;
  try {
    resolved = await provider.resolveSource(classified.kind, classified.value);
  } catch (err) {
    // Source failures throw, input misses come back as values.
    if (err instanceof PlatformError) {
      return resolveFailure(err.failure);
    }
    throw err;
  }
  if ('failure' in resolved) {
    return resolveFailure(resolved.failure);
  }
  // Same source with every default counter and channel in place needs no recreate.
  const existing = await selectPanel(guildId, platform);
  let alreadyTracked = false;
  if (existing && existing.sourceId === resolved.sourceId) {
    const oldCounters = await selectCountersWithReasons([existing.id]);
    alreadyTracked =
      Object.keys(DEFAULT_TEMPLATES[platform]).every((type) => oldCounters.some((counter) => counter.type === type)) &&
      (await channelsPresent(client, guildId, oldCounters.map((counter) => counter.channelId)));
  }
  return { status: 200, payload: { sourceId: resolved.sourceId, sourceName: resolved.sourceName, alreadyTracked } };
}

async function route(client: Client, providers: Providers, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://transport.local');
  if (req.method === 'POST' && (url.pathname === '/panels' || url.pathname === '/resolve')) {
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
    const result = url.pathname === '/panels'
      ? await handleMutation(client, body)
      : await handleResolve(client, providers, body);
    send(res, result.status, result.payload);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/panels') {
    const guildId = url.searchParams.get('guildId') ?? '';
    if (!SNOWFLAKE.safeParse(guildId).success) {
      send(res, 400, { error: 'guildId is a required snowflake' });
      return;
    }
    const result = await handleList(client, guildId);
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
    send(res, 200, { allowed: await checkManageChannels(client, guildId, userId) });
    return;
  }
  send(res, 404, { error: 'not found' });
}

async function handle(client: Client, providers: Providers, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    log.warn({ ip: req.socket.remoteAddress, path: req.url }, 'transport auth failed');
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!client.isReady()) {
    send(res, 503, { error: 'bot is starting up' });
    return;
  }
  await route(client, providers, req, res);
}

export function startTransport(client: Client, providers: Providers, port: number): http.Server | undefined {
  if (!config.TRANSPORT_SECRET) {
    log.warn('TRANSPORT_SECRET not set. Transport disabled.');
    return undefined;
  }
  if (client.shard && !client.shard.ids.includes(0)) {
    log.info({ ids: client.shard.ids.join(',') }, 'transport lives on shard 0');
    return undefined;
  }
  const server = http.createServer((req, res) => {
    handle(client, providers, req, res).catch((err) => {
      log.error({ err }, 'transport handler crashed');
      send(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, () => {
    log.info({ port }, 'transport listening (compose network only)');
  });
  return server;
}
