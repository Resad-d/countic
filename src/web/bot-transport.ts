import type { CreatedCounter } from '../bot/panels.js';
import type { Platform } from '../lib/counters/platform-types.js';
import { config } from '../lib/config.js';

/**
 * Typed client for the bot internal transport.
 * Failures normalize into kinds so dashboard handlers can react precisely.
 */

export type TransportErrorKind = 'unconfigured' | 'unreachable' | 'not-ready' | 'not-found' | 'conflict' | 'rejected';

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly body?: Record<string, unknown>;

  constructor(kind: TransportErrorKind, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.body = body;
  }
}

async function call<T extends object>(path: string, init: RequestInit = {}): Promise<T> {
  const base = config.TRANSPORT_URL;
  const secret = config.TRANSPORT_SECRET;
  if (!base || !secret) {
    throw new TransportError('unconfigured', 'TRANSPORT_URL or TRANSPORT_SECRET missing');
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-transport-secret': secret },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new TransportError('unreachable', 'bot transport unreachable');
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  const errBody = (body ?? undefined) as unknown as Record<string, unknown> | undefined;
  if (res.status === 503) {
    throw new TransportError('not-ready', 'bot is starting up');
  }
  if (res.status === 404) {
    throw new TransportError('not-found', body?.error ?? 'not found', errBody);
  }
  if (res.status === 409) {
    throw new TransportError('conflict', body?.error ?? 'conflict', errBody);
  }
  if (!res.ok) {
    throw new TransportError('rejected', body?.error ?? `transport status ${res.status}`, errBody);
  }
  return body as T;
}

export type CarryOverEntry = { type: string; template: string | null; numberFormat: 'compact' | 'full' };

export async function createPanel(input: {
  guildId: string;
  platform: Platform;
  sourceId: string;
  sourceName: string;
  carryOver?: CarryOverEntry[];
}): Promise<{ panelId: number; counters: CreatedCounter[] }> {
  return call('/panels', { method: 'POST', body: JSON.stringify({ action: 'create', ...input }) });
}

export async function deletePanel(input: {
  guildId: string;
  platform: Platform;
}): Promise<{ counterCount: number; leftover: number }> {
  return call('/panels', { method: 'POST', body: JSON.stringify({ action: 'teardown', ...input }) });
}

export async function hasManageChannels(guildId: string, userId: string): Promise<boolean> {
  const query = `guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}`;
  const result = await call<{ allowed: boolean }>(`/permissions?${query}`);
  return result.allowed === true;
}

export interface DashCounter {
  id: number;
  panelId: number;
  type: string;
  channelId: string;
  enabled: boolean;
  numberFormat: 'compact' | 'full';
  template: string | null;
  reason: string | null;
}

export interface DashPanel {
  platform: Platform;
  enabled: boolean;
  reason: string | null;
  sourceId: string | null;
  sourceName: string | null;
  lastCheckedAt: string | null;
  lastStats: Record<string, number | null> | null;
  counters: DashCounter[];
}

export interface GuildPanels {
  locale: string;
  panels: DashPanel[];
}

export async function listPanels(guildId: string): Promise<GuildPanels> {
  const query = `guildId=${encodeURIComponent(guildId)}`;
  return call<GuildPanels>(`/panels?${query}`);
}

export interface ResolvedSource {
  sourceId: string;
  sourceName: string;
  alreadyTracked: boolean;
}

export async function resolveSource(input: {
  guildId: string;
  platform: Platform;
  query: string;
}): Promise<ResolvedSource> {
  return call('/resolve', { method: 'POST', body: JSON.stringify(input) });
}

export interface CounterSave {
  template: string | null;
  numberFormat: 'compact' | 'full';
  enabled: boolean;
}

export async function saveCounter(
  input: { guildId: string; platform: Platform; counterId: number } & CounterSave,
): Promise<void> {
  await call('/panels', { method: 'POST', body: JSON.stringify({ action: 'counter-save', ...input }) });
}

/** Swaps the tracked source in place, the existing channels keep their ids. */
export async function updatePanelSource(input: {
  guildId: string;
  platform: Platform;
  sourceId: string;
  sourceName: string;
}): Promise<void> {
  await call('/panels', { method: 'POST', body: JSON.stringify({ action: 'source', ...input }) });
}

export async function deleteCounter(input: {
  guildId: string;
  platform: Platform;
  counterId: number;
}): Promise<{ deleted: boolean; leftover: number }> {
  return call('/panels', { method: 'POST', body: JSON.stringify({ action: 'counter-delete', ...input }) });
}
