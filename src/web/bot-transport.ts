import type { CreatedCounter } from '../bot/panels.js';
import type { Platform } from '../lib/counters/platform-types.js';
import { config } from '../lib/config.js';

/**
 * Typed client for the bot internal transport.
 * Failures normalize into kinds so dashboard handlers can react precisely.
 */

export type TransportErrorKind = 'unconfigured' | 'unreachable' | 'not-ready' | 'rejected';

export class TransportError extends Error {
  constructor(readonly kind: TransportErrorKind, message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

type TransportBody = Record<string, unknown> | unknown[];

async function call<T extends TransportBody>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (res.status === 503) {
    throw new TransportError('not-ready', 'bot is starting up');
  }
  if (!res.ok) {
    throw new TransportError('rejected', body?.error ?? `transport status ${res.status}`);
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

export async function hasManageGuild(guildId: string, userId: string): Promise<boolean> {
  const query = `guildId=${encodeURIComponent(guildId)}&userId=${encodeURIComponent(userId)}`;
  const result = await call<{ allowed: boolean }>(`/permissions?${query}`);
  return result.allowed === true;
}
