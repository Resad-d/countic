import { childLogger } from '../../lib/logger.js';
import { createClientCredentialsToken, type TokenManager } from '../../lib/oauth-token.js';
import { PlatformError, type FetchResult, type PlatformProvider, type ResolveResult, type SourceKind } from '../../lib/counters/platform-types.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX = 'https://api.twitch.tv/helix';
// Helix accepts up to 100 ids per users or streams call.
const BATCH_SIZE = 100;

type UsersBody = { data?: Array<{ id?: string; display_name?: string }> };
type StreamsBody = { data?: Array<{ user_id?: string; viewer_count?: number }> };
type FollowersBody = { total?: number };

export function createTwitchProvider(clientId: string, clientSecret: string): PlatformProvider {
  const log = childLogger('platform.twitch');
  const tokens: TokenManager = createClientCredentialsToken(TOKEN_URL, clientId, clientSecret, 'twitch');

  async function helix(path: string): Promise<unknown> {
    const token = await tokens.get();
    let res = await helixRequest(path, token);
    if (res.status === 401) {
      // Token died early, refresh once and retry.
      tokens.invalidate();
      res = await helixRequest(path, await tokens.get());
    }
    if (res.ok) {
      return res.json();
    }
    const message = `${path} ${res.status} ${await safeText(res)}`;
    log.warn({ status: res.status, path }, 'helix request failed');
    throw new PlatformError(res.status >= 400 && res.status < 500 && res.status !== 429 ? 'permanent' : 'transient', message);
  }

  async function helixRequest(path: string, token: string): Promise<Response> {
    return fetch(`${HELIX}/${path}`, {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
    });
  }

  return {
    platform: 'twitch',

    async resolveSource(kind: SourceKind, value: string): Promise<ResolveResult> {
      if (kind !== 'twitch-login') {
        return { failure: 'invalid', message: `twitch cannot resolve ${kind}` };
      }
      const body = (await helix(`users?${new URLSearchParams({ login: value }).toString()}`)) as UsersBody;
      const user = body.data?.[0];
      if (!user?.id) {
        return { failure: 'not-found', message: `twitch user not found for ${value}` };
      }
      return { sourceId: user.id, sourceName: user.display_name ?? value };
    },

    async fetchStats(sourceIds: string[]): Promise<Map<string, FetchResult>> {
      const results = new Map<string, FetchResult>();

      // Identity first, ids that fail the users lookup never reach the stat calls.
      const names = new Map<string, string>();
      for (let i = 0; i < sourceIds.length; i += BATCH_SIZE) {
        const batch = sourceIds.slice(i, i + BATCH_SIZE);
        const params = new URLSearchParams();
        for (const id of batch) {
          params.append('id', id);
        }
        try {
          const body = (await helix(`users?${params.toString()}`)) as UsersBody;
          for (const user of body.data ?? []) {
            if (user.id) {
              names.set(user.id, user.display_name ?? user.id);
            }
          }
        } catch (err) {
          const failure = err instanceof PlatformError ? err.failure : 'transient';
          const message = err instanceof Error ? err.message : String(err);
          for (const id of batch) {
            results.set(id, { failure, message });
          }
        }
      }

      // Live viewers, offline sources simply have no key.
      const viewers = new Map<string, number>();
      const liveIds = sourceIds.filter((id) => names.has(id));
      for (let i = 0; i < liveIds.length; i += BATCH_SIZE) {
        const batch = liveIds.slice(i, i + BATCH_SIZE);
        const params = new URLSearchParams();
        for (const id of batch) {
          params.append('user_id', id);
        }
        try {
          const body = (await helix(`streams?${params.toString()}`)) as StreamsBody;
          for (const stream of body.data ?? []) {
            if (stream.user_id && typeof stream.viewer_count === 'number') {
              viewers.set(stream.user_id, stream.viewer_count);
            }
          }
        } catch (err) {
          log.warn({ err }, 'twitch streams lookup failed, viewers omitted');
        }
      }

      // No multi-broadcaster followers endpoint, one call per source.
      for (const id of liveIds) {
        const followers = await fetchFollowers(id).catch((err: unknown) => {
          log.warn({ err, id }, 'twitch followers lookup failed, followers omitted');
          return undefined;
        });
        results.set(id, {
          sourceName: names.get(id) ?? id,
          values: {
            followers: followers,
            viewers: viewers.get(id),
          },
        });
      }
      return results;
    },
  };

  async function fetchFollowers(id: string): Promise<number> {
    const body = (await helix(`channels/followers?${new URLSearchParams({ broadcaster_id: id }).toString()}`)) as FollowersBody;
    if (typeof body.total !== 'number') {
      throw new PlatformError('transient', `followers response missing total for ${id}`);
    }
    return body.total;
  }
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 200);
}
