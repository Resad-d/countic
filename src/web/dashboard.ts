import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { insertCommandUsage } from '../db/queries.js';
import { formatCount } from '../lib/counters/format.js';
import { counterName } from '../lib/counters/names.js';
import { PLATFORMS, type Platform } from '../lib/counters/platform-types.js';
import { DEFAULT_TEMPLATES, OFFLINE_LABEL, PENDING_LABEL, defaultNumberFormat } from '../lib/counters/templates.js';
import { counterText, en, translator } from '../lib/i18n/index.js';
import { childLogger } from '../lib/logger.js';
import type { GuildStub, SessionUser } from './auth.js';
import {
  TransportError,
  createPanel,
  deleteCounter,
  deletePanel,
  hasManageChannels,
  listPanels,
  resolveSource,
  saveCounter,
  updatePanelSource,
  type CarryOverEntry,
  type DashCounter,
  type DashPanel,
  type GuildPanels,
} from './bot-transport.js';

/**
 * Dashboard routes: server picker and panel management.
 * Every mutation re-checks Manage Channels live through the transport.
 */

const log = childLogger('dashboard');

const SNOWFLAKE = /^\d{17,20}$/;
const PLATFORM_ENUM = z.enum(['youtube', 'twitch', 'kick']);
const MANAGE_CHANNELS = 16n;
const RESOLVE_FAIL_TEXT = 'Type a channel name first.';
const REPLACE_TTL_MS = 30_000;

type DashFlash =
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'resolved'; platform: Platform; sourceId: string; sourceName: string };

interface DashPending {
  guildId: string;
  platform: Platform;
  sourceId: string;
  sourceName: string;
  carryOver: CarryOverEntry[];
  expires: number;
}

declare module 'express-session' {
  interface SessionData {
    dashPending?: DashPending;
    dashFlash?: DashFlash;
    csrf?: string;
  }
}

const dashPostLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // The fetch actions need JSON errors, plain text would break their toast.
  handler: (req, res) => {
    if (wantsJson(req)) {
      res.status(429).json({ ok: false, message: 'Too many requests, slow down.' });
      return;
    }
    res.status(429).send('Too many requests, slow down.');
  },
});

const resolveForm = z.object({
  platform: PLATFORM_ENUM,
  query: z.string().trim().min(1).max(100),
});

const panelsForm = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    platform: PLATFORM_ENUM,
    sourceId: z.string().min(1).max(64),
    sourceName: z.string().min(1).max(100),
  }),
  z.object({ action: z.literal('teardown'), platform: PLATFORM_ENUM }),
  z.object({ action: z.literal('replace'), platform: PLATFORM_ENUM }),
  z.object({
    action: z.literal('source'),
    platform: PLATFORM_ENUM,
    sourceId: z.string().min(1).max(64),
    sourceName: z.string().min(1).max(100),
  }),
  z.object({ action: z.literal('recreate'), platform: PLATFORM_ENUM }),
]);

const countersForm = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    platform: PLATFORM_ENUM,
    counterId: z.coerce.number().int().positive(),
    template: z.string().max(100).optional(),
    numberFormat: z.enum(['compact', 'full']),
    enabled: z.enum(['true', 'false']),
  }),
  z.object({
    action: z.literal('delete'),
    platform: PLATFORM_ENUM,
    counterId: z.coerce.number().int().positive(),
  }),
]);

const PLATFORM_ICONS: Record<Platform, string> = {
  youtube: '/img/youtube.webp',
  twitch: '/img/twitch.webp',
  kick: '/img/kick.png',
};
const t = translator('en');
const platformLabel = (platform: Platform): string => en[`platform.${platform}`];
const typeLabel = (type: string): string => counterText(t, type);

const guildPath = (guildId: string): string => `/dashboard/guilds/${guildId}`;
const platformPath = (guildId: string, platform: Platform): string => `${guildPath(guildId)}/${platform}`;

const inflight = new Map<string, Promise<unknown>>();

// One queue per guild, wrapped tasks run strictly one after another.
function serialized<T>(guildId: string, task: () => Promise<T>): Promise<T> {
  // Chain on the previous task, its failure must not block this one.
  const tail = (inflight.get(guildId) ?? Promise.resolve()).catch(() => { });
  const run = tail.then(task);
  const settled = run.catch(() => { });
  // Retire the queue only if this task is still the newest entry.
  void settled.then(() => {
    if (inflight.get(guildId) === settled) {
      inflight.delete(guildId);
    }
  });
  inflight.set(guildId, settled);
  return run;
}

function snapshotManageChannels(guild: GuildStub): boolean {
  if (guild.owner) {
    return true;
  }
  try {
    return (BigInt(guild.permissions) & MANAGE_CHANNELS) !== 0n;
  } catch {
    return false;
  }
}

function guildIconUrl(guild: GuildStub): string | null {
  return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null;
}

function timeAgo(iso: string | null): string {
  if (!iso) {
    return 'never';
  }
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) {
    return 'never';
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function setFlash(req: Request, flash: DashFlash): void {
  req.session.dashFlash = flash;
}

function takeFlash(req: Request): DashFlash | null {
  const flash = req.session.dashFlash ?? null;
  delete req.session.dashFlash;
  return flash;
}

function wantsJson(req: Request): boolean {
  return (req.get('accept') ?? '').includes('application/json');
}

// JSON requests get a status and body, the PRG fallback keeps flash + redirect.
function finish(
  req: Request,
  res: Response,
  ok: boolean,
  message: string,
  redirect: string,
  extra: Record<string, unknown> = {},
  status?: number,
): void {
  if (wantsJson(req)) {
    res.status(status ?? (ok ? 200 : 400)).json({ ok, message, ...extra });
    return;
  }
  setFlash(req, { kind: ok ? 'ok' : 'error', text: message });
  res.redirect(redirect);
}

function ensureCsrf(req: Request): string {
  req.session.csrf ??= randomBytes(32).toString('hex');
  return req.session.csrf;
}

function csrfOk(req: Request): boolean {
  const expected = req.session.csrf;
  const body = req.body as { _csrf?: unknown } | undefined;
  const provided = typeof body?._csrf === 'string' ? body._csrf : '';
  if (!expected || provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

interface Guarded {
  user: SessionUser;
  guildId: string;
}

// Login comes back to the page that asked for it.
function loginRedirect(req: Request, res: Response): void {
  res.redirect(`/login?return=${encodeURIComponent(req.originalUrl)}`);
}

// Session, CSRF token, snowflake shape and guild membership from the login snapshot.
function guard(req: Request, res: Response): Guarded | null {
  const user = req.session.user;
  if (!user) {
    if (wantsJson(req)) {
      res.status(401).json({ ok: false, message: 'Your session expired, refresh the page.' });
      return null;
    }
    loginRedirect(req, res);
    return null;
  }
  if (!csrfOk(req)) {
    if (wantsJson(req)) {
      res.status(403).json({ ok: false, message: 'Invalid request, refresh the page and try again.' });
      return null;
    }
    res.status(403).send('Invalid request, go back and try again.');
    return null;
  }
  const guildId = String(req.params.guildId ?? '');
  if (!SNOWFLAKE.test(guildId) || !user.guilds.some((guild) => guild.id === guildId)) {
    res.status(404).send('Not found.');
    return null;
  }
  return { user, guildId };
}

async function allowedNow(guildId: string, userId: string): Promise<boolean> {
  try {
    return await hasManageChannels(guildId, userId);
  } catch {
    return false;
  }
}

async function record(req: Request, guildId: string, detail: string, ok: boolean): Promise<void> {
  const user = req.session.user;
  if (!user) {
    return;
  }
  try {
    await insertCommandUsage({ command: 'dashboard', guildId, userId: user.id, ok, detail });
  } catch (err) {
    log.warn({ err }, 'dashboard usage insert failed');
  }
}

function rejectedText(message: string): string {
  switch (message) {
    case 'resolution cap reached':
      return 'Daily limit reached for this server, try again tomorrow.';
    case 'quota exhausted':
      return 'The bot hit its YouTube quota for today, try again tomorrow.';
    case 'invalid source':
      return 'That does not look like a valid channel.';
    case 'platform unavailable':
      return 'That platform is not available right now.';
    default:
      return 'Something went wrong, try again.';
  }
}

function mutationErrorText(err: unknown): string {
  if (err instanceof TransportError) {
    if (err.kind === 'not-found') {
      if (err.message === 'guild not found') {
        return 'Countic is not in that server anymore, invite it back first.';
      }
      if (err.message === 'source not found') {
        return 'No channel found for that name, check the spelling.';
      }
      return 'That was already removed, refresh the page.';
    }
    if (err.kind === 'conflict') {
      return 'A panel for that platform already exists, try again.';
    }
    if (err.kind === 'not-ready' || err.kind === 'unreachable' || err.kind === 'unconfigured') {
      return 'The bot is starting up, try again in a moment.';
    }
    return rejectedText(err.message);
  }
  log.warn({ err }, 'dashboard mutation failed');
  return 'Something went wrong, try again.';
}

function counterErrorText(err: unknown): string {
  if (err instanceof TransportError) {
    if (err.kind === 'not-found') {
      return 'That counter no longer exists, refresh the page.';
    }
    if (err.message === 'category has no format') {
      return 'The category counter has no number format.';
    }
    if (err.message === 'need-placeholder') {
      const placeholder = typeof err.body?.placeholder === 'string' ? err.body.placeholder : 'the placeholder';
      return `Template must contain ${placeholder}.`;
    }
    if (err.message === 'category-no-stats') {
      return 'Category templates cannot contain stat placeholders.';
    }
    if (err.message === 'too-long') {
      const length = typeof err.body?.length === 'number' ? err.body.length : 0;
      return `That renders to ${length} characters, the limit is 100.`;
    }
  }
  return mutationErrorText(err);
}

type CounterView = {
  id: number;
  type: string;
  enabled: boolean;
  numberFormat: 'compact' | 'full';
  template: string;
  defaultTemplate: string;
  label: string;
  reason: string | null;
  value: string;
};

type PanelView = {
  platform: Platform;
  label: string;
  icon: string;
  exists: boolean;
  enabled: boolean;
  reason: string | null;
  sourceName: string | null;
  sourceId: string | null;
  lastChecked: string | null;
  stats: { label: string; value: string }[];
  counters: CounterView[];
};

function statValue(counter: DashCounter, stats: { values: Record<string, number> } | null, locale: string): string {
  const raw = stats?.values[counter.type];
  if (raw === undefined) {
    return stats === null ? PENDING_LABEL : OFFLINE_LABEL;
  }
  return formatCount(raw, counter.numberFormat, locale);
}

function panelView(platform: Platform, panel: DashPanel | undefined, locale: string): PanelView {
  const stats = panel?.lastStats ? { sourceName: panel.sourceName ?? '', values: panel.lastStats } : null;
  const defaults = DEFAULT_TEMPLATES[platform] as Partial<Record<string, string>>;
  const rows = panel?.counters ?? [];
  return {
    platform,
    label: platformLabel(platform),
    icon: PLATFORM_ICONS[platform],
    exists: Boolean(panel),
    enabled: panel?.enabled ?? false,
    reason: panel?.reason ?? null,
    sourceName: panel?.sourceName ?? null,
    sourceId: panel?.sourceId ?? null,
    lastChecked: panel?.lastCheckedAt ? timeAgo(panel.lastCheckedAt) : null,
    stats: rows
      .filter((counter) => counter.type !== 'category')
      .map((counter) => ({ label: typeLabel(counter.type), value: statValue(counter, stats, locale) })),
    counters: rows.map((counter) => ({
      id: counter.id,
      type: counter.type,
      channelId: counter.channelId,
      enabled: counter.enabled,
      numberFormat: counter.numberFormat,
      template: counter.template ?? '',
      defaultTemplate: defaults[counter.type] ?? '',
      label: typeLabel(counter.type),
      reason: counter.reason,
      value: counterName(counter, platform, stats, locale) ?? '...',
    })),
  };
}

const SAMPLE_VALUES: Record<string, number> = {
  subs: 1_230_000,
  views: 4_560_000_000,
  videos: 1_250,
  followers: 45_000,
  viewers: 850,
};

type PreviewRow = { type: string; name: string; enabled: boolean };

function previewRows(platform: Platform, panel: DashPanel | undefined, locale: string): PreviewRow[] {
  if (panel) {
    const stats = panel.lastStats ? { sourceName: panel.sourceName ?? '', values: panel.lastStats } : null;
    return panel.counters.map((counter) => ({
      type: counter.type,
      name: counterName(counter, platform, stats, locale) ?? counter.type,
      enabled: counter.enabled,
    }));
  }
  const stats = { sourceName: 'Your Channel', values: SAMPLE_VALUES };
  return Object.keys(DEFAULT_TEMPLATES[platform]).map((type) => ({
    type,
    name: counterName({ type, template: null, numberFormat: defaultNumberFormat(type) }, platform, stats, locale) ?? type,
    enabled: true,
  }));
}

function guildCard(stub: GuildStub): { id: string; name: string; icon: string | null; initial: string } {
  return {
    id: stub.id,
    name: stub.name,
    icon: guildIconUrl(stub),
    initial: stub.name.charAt(0).toUpperCase(),
  };
}

export const dashboardRouter = Router();

dashboardRouter.get('/', (req, res) => {
  const user = req.session.user;
  if (!user) {
    loginRedirect(req, res);
    return;
  }
  const guilds = user.guilds.filter(snapshotManageChannels).map(guildCard);
  res.render('dashboard/index', { title: 'Dashboard', guilds });
});

dashboardRouter.get('/guilds/:guildId', async (req, res) => {
  const user = req.session.user;
  if (!user) {
    loginRedirect(req, res);
    return;
  }
  const guildId = String(req.params.guildId ?? '');
  const stub = user.guilds.find((guild) => guild.id === guildId);
  if (!SNOWFLAKE.test(guildId) || !stub || !snapshotManageChannels(stub)) {
    res.status(404).render('404');
    return;
  }
  const flash = takeFlash(req);
  let panels: DashPanel[] | null = null;
  let locale = 'en';
  let botMissing = false;
  let unreachable = false;
  try {
    const listed = await listPanels(guildId);
    panels = listed.panels;
    locale = listed.locale;
  } catch (err) {
    if (err instanceof TransportError && err.kind === 'not-found') {
      botMissing = true;
    } else {
      log.warn({ err, guildId }, 'panel list failed');
      unreachable = true;
    }
  }
  const byPlatform = new Map((panels ?? []).map((panel) => [panel.platform, panel]));
  res.render('dashboard/guild', {
    title: `${stub.name} - Dashboard`,
    guild: guildCard(stub),
    panels: PLATFORMS.map((platform) => panelView(platform, byPlatform.get(platform), locale)),
    botMissing,
    unreachable,
    flash,
  });
});

dashboardRouter.get('/guilds/:guildId/:platform', async (req, res) => {
  const user = req.session.user;
  if (!user) {
    loginRedirect(req, res);
    return;
  }
  const guildId = String(req.params.guildId ?? '');
  const stub = user.guilds.find((guild) => guild.id === guildId);
  const platform = PLATFORMS.find((entry) => entry === req.params.platform);
  if (!SNOWFLAKE.test(guildId) || !stub || !platform || !snapshotManageChannels(stub)) {
    res.status(404).render('404');
    return;
  }
  const flash = takeFlash(req);
  let listed: GuildPanels | null = null;
  let botMissing = false;
  let unreachable = false;
  try {
    listed = await listPanels(guildId);
  } catch (err) {
    if (err instanceof TransportError && err.kind === 'not-found') {
      botMissing = true;
    } else {
      log.warn({ err, guildId }, 'panel list failed');
      unreachable = true;
    }
  }
  const locale = listed?.locale ?? 'en';
  const panelRow = listed?.panels.find((row) => row.platform === platform);
  const panels = PLATFORMS.map((entry) =>
    panelView(entry, listed?.panels.find((row) => row.platform === entry), locale),
  );
  res.render('dashboard/platform', {
    title: `${platformLabel(platform)} - ${stub.name} - Dashboard`,
    guild: guildCard(stub),
    platform,
    panels,
    panel: panels.find((entry) => entry.platform === platform),
    preview: previewRows(platform, panelRow, locale),
    botMissing,
    unreachable,
    resolved: flash?.kind === 'resolved' ? flash : null,
    flash: flash !== null && flash.kind !== 'resolved' ? flash : null,
    csrf: ensureCsrf(req),
  });
});

dashboardRouter.get('/guilds/:guildId/replace/:platform', async (req, res) => {
  const user = req.session.user;
  if (!user) {
    loginRedirect(req, res);
    return;
  }
  const guildId = String(req.params.guildId ?? '');
  const stub = user.guilds.find((guild) => guild.id === guildId);
  const platform = PLATFORMS.find((entry) => entry === req.params.platform);
  if (!SNOWFLAKE.test(guildId) || !stub || !platform || !snapshotManageChannels(stub)) {
    res.status(404).render('404');
    return;
  }
  const pending = req.session.dashPending;
  if (!pending || pending.guildId !== guildId || pending.platform !== platform) {
    setFlash(req, { kind: 'error', text: 'Nothing to replace, start again from the server page.' });
    res.redirect(platformPath(guildId, platform));
    return;
  }
  if (pending.expires <= Date.now()) {
    delete req.session.dashPending;
    setFlash(req, { kind: 'error', text: 'That replace request expired, start again from the server page.' });
    res.redirect(platformPath(guildId, platform));
    return;
  }
  // The old source name tells the user which panel they are about to delete.
  let oldSourceName: string | null = null;
  try {
    const listed = await listPanels(guildId);
    oldSourceName = listed.panels.find((row) => row.platform === platform)?.sourceName ?? null;
  } catch {
    // Generic wording still renders when the bot is unreachable.
  }
  res.render('dashboard/replace', {
    title: 'Replace panel',
    guild: guildCard(stub),
    platform,
    platformLabel: platformLabel(platform),
    platformIcon: PLATFORM_ICONS[platform],
    pending,
    carryLabels: pending.carryOver.map((entry) => typeLabel(entry.type)),
    oldSourceName,
    csrf: ensureCsrf(req),
  });
});

dashboardRouter.post('/guilds/:guildId/resolve', dashPostLimiter, async (req, res) => {
  const context = guard(req, res);
  if (!context) {
    return;
  }
  const { guildId, user } = context;
  const parsed = resolveForm.safeParse(req.body);
  if (!parsed.success) {
    setFlash(req, { kind: 'error', text: RESOLVE_FAIL_TEXT });
    res.redirect(guildPath(guildId));
    return;
  }
  // The platform suffix records which platform the resolve used.
  const detail = `resolve:${parsed.data.platform}`;
  if (!(await allowedNow(guildId, user.id))) {
    await record(req, guildId, detail, false);
    setFlash(req, { kind: 'error', text: 'You need Manage Channels permission for that.' });
    res.redirect(platformPath(guildId, parsed.data.platform));
    return;
  }
  try {
    const resolved = await serialized(guildId, () =>
      resolveSource({ guildId, platform: parsed.data.platform, query: parsed.data.query }),
    );
    await record(req, guildId, detail, true);
    if (resolved.alreadyTracked) {
      setFlash(req, { kind: 'ok', text: `${resolved.sourceName} is already tracked on this server.` });
    } else {
      setFlash(req, {
        kind: 'resolved',
        platform: parsed.data.platform,
        sourceId: resolved.sourceId,
        sourceName: resolved.sourceName,
      });
    }
  } catch (err) {
    await record(req, guildId, detail, false);
    setFlash(req, { kind: 'error', text: mutationErrorText(err) });
  }
  res.redirect(platformPath(guildId, parsed.data.platform));
});

dashboardRouter.post('/guilds/:guildId/panels', dashPostLimiter, async (req, res) => {
  const context = guard(req, res);
  if (!context) {
    return;
  }
  const { guildId, user } = context;
  const parsed = panelsForm.safeParse(req.body);
  if (!parsed.success) {
    setFlash(req, { kind: 'error', text: 'That request was not valid, try again.' });
    res.redirect(guildPath(guildId));
    return;
  }
  if (!(await allowedNow(guildId, user.id))) {
    await record(req, guildId, parsed.data.action, false);
    setFlash(req, { kind: 'error', text: 'You need Manage Channels permission for that.' });
    res.redirect(guildPath(guildId));
    return;
  }
  const input = parsed.data;
  if (input.action === 'create') {
    await handleCreate(req, res, guildId, input);
    return;
  }
  if (input.action === 'teardown') {
    await handleTeardown(req, res, guildId, input.platform);
    return;
  }
  if (input.action === 'source') {
    await handleSource(req, res, guildId, input);
    return;
  }
  if (input.action === 'recreate') {
    await handleRecreate(req, res, guildId, input.platform);
    return;
  }
  await handleReplace(req, res, guildId, input.platform);
});

type CreateInput = Extract<z.infer<typeof panelsForm>, { action: 'create' }>;
type CreateOutcome = { kind: 'created' } | { kind: 'confirm'; carryOver: CarryOverEntry[] };

async function createOrConfirm(
  guildId: string,
  platform: Platform,
  sourceId: string,
  sourceName: string,
): Promise<CreateOutcome> {
  try {
    await createPanel({ guildId, platform, sourceId, sourceName });
    return { kind: 'created' };
  } catch (err) {
    if (!(err instanceof TransportError) || err.kind !== 'conflict') {
      throw err;
    }
    const listed = await listPanels(guildId).catch(() => null);
    const existing = listed?.panels.find((panel) => panel.platform === platform);
    if (!existing) {
      // The panel vanished between the conflict and this read, the slot is free.
      await createPanel({ guildId, platform, sourceId, sourceName });
      return { kind: 'created' };
    }
    return {
      kind: 'confirm',
      carryOver: existing.counters.map((counter) => ({
        type: counter.type,
        template: counter.template,
        numberFormat: counter.numberFormat,
      })),
    };
  }
}

async function handleCreate(req: Request, res: Response, guildId: string, input: CreateInput): Promise<void> {
  try {
    const outcome = await serialized(guildId, () =>
      createOrConfirm(guildId, input.platform, input.sourceId, input.sourceName),
    );
    await record(req, guildId, 'create', true);
    if (outcome.kind === 'confirm') {
      req.session.dashPending = {
        guildId,
        platform: input.platform,
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        carryOver: outcome.carryOver,
        expires: Date.now() + REPLACE_TTL_MS,
      };
      res.redirect(`${guildPath(guildId)}/replace/${input.platform}`);
      return;
    }
    setFlash(req, { kind: 'ok', text: `Panel created for ${input.sourceName}.` });
  } catch (err) {
    await record(req, guildId, 'create', false);
    setFlash(req, { kind: 'error', text: mutationErrorText(err) });
  }
  res.redirect(platformPath(guildId, input.platform));
}

async function handleTeardown(req: Request, res: Response, guildId: string, platform: Platform): Promise<void> {
  try {
    const result = await serialized(guildId, () => deletePanel({ guildId, platform }));
    await record(req, guildId, 'teardown', true);
    const extra =
      result.leftover > 0 ? ` ${result.leftover} channel(s) could not be deleted, remove them manually.` : '';
    setFlash(req, { kind: 'ok', text: `Panel removed with ${result.counterCount} counter(s).${extra}` });
  } catch (err) {
    if (err instanceof TransportError && err.kind === 'not-found') {
      await record(req, guildId, 'teardown', true);
      setFlash(req, { kind: 'ok', text: 'That panel was already removed.' });
    } else {
      await record(req, guildId, 'teardown', false);
      setFlash(req, { kind: 'error', text: mutationErrorText(err) });
    }
  }
  res.redirect(guildPath(guildId));
}

type SourceInput = Extract<z.infer<typeof panelsForm>, { action: 'source' }>;

async function handleSource(req: Request, res: Response, guildId: string, input: SourceInput): Promise<void> {
  try {
    await serialized(guildId, () =>
      updatePanelSource({
        guildId,
        platform: input.platform,
        sourceId: input.sourceId,
        sourceName: input.sourceName,
      }),
    );
    await record(req, guildId, 'source', true);
    setFlash(req, { kind: 'ok', text: `Source changed to ${input.sourceName}, names refresh with the next update.` });
  } catch (err) {
    await record(req, guildId, 'source', false);
    setFlash(req, { kind: 'error', text: mutationErrorText(err) });
  }
  res.redirect(platformPath(guildId, input.platform));
}

async function handleRecreate(req: Request, res: Response, guildId: string, platform: Platform): Promise<void> {
  try {
    const pending = await serialized(guildId, async () => {
      const listed = await listPanels(guildId);
      const existing = listed.panels.find((panel) => panel.platform === platform);
      if (!existing || !existing.sourceId || !existing.sourceName) {
        return null;
      }
      return {
        sourceId: existing.sourceId,
        sourceName: existing.sourceName,
        carryOver: existing.counters.map((counter) => ({
          type: counter.type,
          template: counter.template,
          numberFormat: counter.numberFormat,
        })),
      };
    });
    if (!pending) {
      await record(req, guildId, 'recreate', false);
      setFlash(req, { kind: 'error', text: 'Nothing to recreate, set up a source first.' });
      res.redirect(platformPath(guildId, platform));
      return;
    }
    await record(req, guildId, 'recreate', true);
    req.session.dashPending = {
      guildId,
      platform,
      sourceId: pending.sourceId,
      sourceName: pending.sourceName,
      carryOver: pending.carryOver,
      expires: Date.now() + REPLACE_TTL_MS,
    };
    res.redirect(`${guildPath(guildId)}/replace/${platform}`);
    return;
  } catch (err) {
    await record(req, guildId, 'recreate', false);
    setFlash(req, { kind: 'error', text: mutationErrorText(err) });
  }
  res.redirect(platformPath(guildId, platform));
}

async function handleReplace(req: Request, res: Response, guildId: string, platform: Platform): Promise<void> {
  const pending = req.session.dashPending;
  delete req.session.dashPending;
  if (!pending || pending.guildId !== guildId || pending.platform !== platform || pending.expires <= Date.now()) {
    setFlash(req, { kind: 'error', text: 'That replace request expired, start again from the server page.' });
    res.redirect(platformPath(guildId, platform));
    return;
  }
  try {
    await serialized(guildId, async () => {
      try {
        await deletePanel({ guildId, platform });
      } catch (err) {
        // Deleted elsewhere while the confirm page was open, nothing to remove.
        if (!(err instanceof TransportError) || err.kind !== 'not-found') {
          throw err;
        }
      }
      await createPanel({
        guildId,
        platform,
        sourceId: pending.sourceId,
        sourceName: pending.sourceName,
        carryOver: pending.carryOver,
      });
    });
    await record(req, guildId, 'replace', true);
    setFlash(req, { kind: 'ok', text: `Panel replaced with ${pending.sourceName}.` });
  } catch (err) {
    await record(req, guildId, 'replace', false);
    setFlash(req, { kind: 'error', text: mutationErrorText(err) });
  }
  res.redirect(platformPath(guildId, platform));
}

dashboardRouter.post('/guilds/:guildId/counters', dashPostLimiter, async (req, res) => {
  const context = guard(req, res);
  if (!context) {
    return;
  }
  const { guildId, user } = context;
  const parsed = countersForm.safeParse(req.body);
  if (!parsed.success) {
    finish(req, res, false, 'That request was not valid, try again.', guildPath(guildId));
    return;
  }
  if (!(await allowedNow(guildId, user.id))) {
    await record(req, guildId, parsed.data.action === 'delete' ? 'counter-delete' : 'save', false);
    finish(
      req,
      res,
      false,
      'You need Manage Channels permission for that.',
      platformPath(guildId, parsed.data.platform),
      {},
      403,
    );
    return;
  }
  const input = parsed.data;
  if (input.action === 'delete') {
    try {
      const result = await serialized(guildId, () =>
        deleteCounter({ guildId, platform: input.platform, counterId: input.counterId }),
      );
      await record(req, guildId, 'counter-delete', true);
      const extra =
        result.leftover > 0 ? ` ${result.leftover} channel(s) could not be deleted, remove them manually.` : '';
      finish(req, res, true, `Counter removed.${extra}`, platformPath(guildId, input.platform));
    } catch (err) {
      await record(req, guildId, 'counter-delete', false);
      finish(req, res, false, counterErrorText(err), platformPath(guildId, input.platform));
    }
    return;
  }
  const template = input.template?.trim() ?? '';
  try {
    await serialized(guildId, () =>
      saveCounter({
        guildId,
        platform: input.platform,
        counterId: input.counterId,
        template,
        numberFormat: input.numberFormat,
        enabled: input.enabled === 'true',
      }),
    );
    await record(req, guildId, 'save', true);
    // The rendered name needs the fresh stats, a failed read just keeps the old text.
    let value: string | undefined;
    try {
      const listed = await listPanels(guildId);
      const row = listed.panels.find((panel) => panel.platform === input.platform);
      value = row
        ? panelView(input.platform, row, listed.locale).counters.find((counter) => counter.id === input.counterId)
          ?.value
        : undefined;
    } catch {
      // Keep the previous name in the row when the read fails.
    }
    finish(
      req,
      res,
      true,
      'Counter saved.',
      `${platformPath(guildId, input.platform)}#counter-${input.counterId}`,
      value === undefined ? {} : { value },
    );
  } catch (err) {
    await record(req, guildId, 'save', false);
    finish(req, res, false, counterErrorText(err), platformPath(guildId, input.platform));
  }
});
