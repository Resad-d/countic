import { childLogger } from '../../lib/logger.js';
import { createClientCredentialsToken, type TokenManager } from '../../lib/oauth-token.js';
import { PlatformError, type FetchResult, type PlatformProvider, type ResolveResult, type SourceKind } from '../../lib/counters/platform-types.js';

const TOKEN_URL = 'https://id.kick.com/oauth/token';
const API = 'https://api.kick.com/public/v1';
// Followers only, the official Kick API has no follower count.
const WIDGET_URL = 'https://kick-stuff.com/widgets/follower-count.php';

type KickChannelsBody = {
  data?: Array<{
    broadcaster_user_id?: string;
    slug?: string;
    name?: string;
    stream?: { is_live?: boolean; viewer_count?: number };
  }>;
};

type KickUsersBody = {
  data?: Array<{ id?: string; username?: string; slug?: string; name?: string }>;
};

export function createKickProvider(clientId: string, clientSecret: string): PlatformProvider {
  const log = childLogger('platform.kick');
  const tokens: TokenManager = createClientCredentialsToken(TOKEN_URL, clientId, clientSecret, 'kick');

  async function kickApi(path: string): Promise<unknown> {
    const token = await tokens.get();
    let res = await kickRequest(path, token);
    if (res.status === 401) {
      tokens.invalidate();
      res = await kickRequest(path, await tokens.get());
    }
    if (res.ok) {
      return res.json();
    }
    const message = `${path} ${res.status} ${await safeText(res)}`;
    log.warn({ status: res.status, path }, 'kick api request failed');
    throw new PlatformError(res.status === 404 || res.status === 400 ? 'permanent' : 'transient', message);
  }

  async function kickRequest(path: string, token: string): Promise<Response> {
    return fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  async function fetchFollowers(slug: string): Promise<number> {
    const res = await fetch(`${WIDGET_URL}?${new URLSearchParams({ streamer: slug, count: '' }).toString()}`);
    if (!res.ok) {
      throw new Error(`kick-stuff request failed with ${res.status}`);
    }
    const digits = (await res.text()).replace(/\D/g, '');
    if (digits.length === 0) {
      throw new Error(`kick-stuff returned no number for ${slug}`);
    }
    return Number(digits);
  }

  return {
    platform: 'kick',

    async resolveSource(kind: SourceKind, value: string): Promise<ResolveResult> {
      if (kind !== 'kick-slug') {
        return { failure: 'invalid', message: `kick cannot resolve ${kind}` };
      }
      const body = (await kickApi(`channels?${new URLSearchParams({ slug: value }).toString()}`)) as KickChannelsBody;
      const channel = body.data?.[0];
      if (!channel?.broadcaster_user_id) {
        return { failure: 'not-found', message: `kick channel not found for ${value}` };
      }
      // The users endpoint carries the display-cased name, the slug is all lowercase.
      const usersBody = (await kickApi(`users?${new URLSearchParams({ id: channel.broadcaster_user_id }).toString()}`)) as KickUsersBody;
      const user = usersBody.data?.[0];
      return { sourceId: channel.broadcaster_user_id, sourceName: user?.name ?? user?.username ?? channel.slug ?? value };
    },

    // Kick API takes a single id per call, comma-separated lists return 400.
    async fetchStats(sourceIds: string[]): Promise<Map<string, FetchResult>> {
      const results = new Map<string, FetchResult>();
      for (const id of sourceIds) {
        try {
          const channelsBody = (await kickApi(`channels?${new URLSearchParams({ broadcaster_user_id: id }).toString()}`)) as KickChannelsBody;
          const channel = channelsBody.data?.[0];
          if (!channel) {
            results.set(id, { failure: 'permanent', message: 'kick channel not found' });
            continue;
          }
          const usersBody = (await kickApi(`users?${new URLSearchParams({ id }).toString()}`)) as KickUsersBody;
          const user = usersBody.data?.[0];
          if (!user) {
            results.set(id, { failure: 'permanent', message: 'kick user not found' });
            continue;
          }
          const slug = channel.slug ?? user.username ?? user.slug ?? user.name?.toLowerCase();
          const sourceName = user.name ?? user.username ?? channel.slug ?? id;
          const offline = channel.stream?.is_live !== true;
          let followers: number | undefined;
          if (slug) {
            followers = await fetchFollowers(slug).catch((err: unknown) => {
              log.warn({ err, slug }, 'kick-stuff followers lookup failed, followers omitted');
              return undefined;
            });
          }
          results.set(id, {
            sourceName,
            values: {
              followers,
              viewers: offline ? undefined : channel.stream?.viewer_count,
            },
          });
        } catch (err) {
          const failure = err instanceof PlatformError ? err.failure : 'transient';
          const message = err instanceof Error ? err.message : String(err);
          results.set(id, { failure, message });
        }
      }
      return results;
    },
  };
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 200);
}
