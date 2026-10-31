import { childLogger } from '../../lib/logger.js';
import {
  PlatformError,
  type FailureKind,
  type FetchResult,
  type PlatformProvider,
  type ResolveResult,
  type SourceKind,
  type Stats,
} from '../../lib/counters/platform-types.js';

const API = 'https://www.googleapis.com/youtube/v3';
// channels.list takes up to 50 ids and costs 1 quota unit per call.
const BATCH_SIZE = 50;

type ChannelItem = {
  id?: string;
  snippet?: { title?: string };
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string };
};

type ChannelsBody = {
  items?: ChannelItem[];
  error?: { message?: string; errors?: Array<{ reason?: string }> };
};

export function createYoutubeProvider(apiKey: string): PlatformProvider {
  const log = childLogger('platform.youtube');

  async function listChannels(params: URLSearchParams): Promise<ChannelsBody> {
    params.set('part', 'snippet,statistics');
    params.set('key', apiKey);
    let res: Response;
    try {
      res = await fetch(`${API}/channels?${params}`);
    } catch (err) {
      throw new PlatformError('transient', `network error ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => ({}))) as ChannelsBody;
    if (res.ok) {
      return body;
    }
    const reason = body.error?.errors?.[0]?.reason;
    const message = `channels ${res.status} ${reason ?? body.error?.message ?? res.statusText}`;
    // Quota errors arrive as 403 with a reason, everything else is not recoverable here.
    const failure: FailureKind = res.status === 403 ? 'quota' : res.status === 400 ? 'permanent' : 'transient';
    log.warn({ status: res.status, reason }, 'youtube channels request failed');
    throw new PlatformError(failure, message);
  }

  function toStats(item: ChannelItem, fallbackName: string): Stats {
    const statistics = item.statistics ?? {};
    return {
      sourceName: item.snippet?.title ?? fallbackName,
      values: {
        subs: statistics.subscriberCount === undefined ? undefined : Number(statistics.subscriberCount),
        views: statistics.viewCount === undefined ? undefined : Number(statistics.viewCount),
        videos: statistics.videoCount === undefined ? undefined : Number(statistics.videoCount),
      },
    };
  }

  return {
    platform: 'youtube',

    async resolveSource(kind: SourceKind, value: string): Promise<ResolveResult> {
      const params = new URLSearchParams();
      if (kind === 'youtube-id') {
        params.set('id', value);
      } else if (kind === 'youtube-handle') {
        params.set('forHandle', value);
      } else if (kind === 'youtube-username') {
        params.set('forUsername', value);
      } else {
        return { failure: 'invalid', message: `youtube cannot resolve ${kind}` };
      }

      const body = await listChannels(params);
      const item = body.items?.[0];
      if (!item?.id) {
        return { failure: 'not-found', message: `youtube channel not found for ${value}` };
      }
      return { sourceId: item.id, sourceName: item.snippet?.title ?? value };
    },

    async fetchStats(sourceIds: string[]): Promise<Map<string, FetchResult>> {
      const results = new Map<string, FetchResult>();
      for (let i = 0; i < sourceIds.length; i += BATCH_SIZE) {
        const batch = sourceIds.slice(i, i + BATCH_SIZE);
        const params = new URLSearchParams({ id: batch.join(',') });
        try {
          const body = await listChannels(params);
          const byId = new Map<string, ChannelItem>();
          for (const item of body.items ?? []) {
            if (item.id) {
              byId.set(item.id, item);
            }
          }
          for (const id of batch) {
            const item = byId.get(id);
            results.set(id, item ? toStats(item, id) : { failure: 'permanent', message: 'channel not found' });
          }
        } catch (err) {
          // A batch shares one API call, so it fails as one.
          const failure = err instanceof PlatformError ? err.failure : 'transient';
          const message = err instanceof Error ? err.message : String(err);
          for (const id of batch) {
            results.set(id, { failure, message });
          }
        }
      }
      return results;
    },
  };
}
