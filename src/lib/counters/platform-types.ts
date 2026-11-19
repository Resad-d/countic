/** Platform data provider contracts shared by the scheduler, commands and tools. */

export const PLATFORMS = ['youtube', 'twitch', 'kick'] as const;

export type Platform = (typeof PLATFORMS)[number];

export type StatKey = 'subs' | 'views' | 'videos' | 'followers' | 'viewers';

export const COUNTER_TYPES = ['category', 'subs', 'views', 'videos', 'followers', 'viewers'] as const;

export type CounterType = (typeof COUNTER_TYPES)[number];

/** How a user input referred to a source, decided by the classifier. */
export type SourceKind =
  | 'youtube-id'
  | 'youtube-handle'
  | 'youtube-username'
  | 'twitch-login'
  | 'kick-slug';

/** Numbers for one source. A missing key means the platform has no such stat or it is unavailable. */
export type Stats = {
  sourceName: string;
  values: Partial<Record<StatKey, number>>;
};

/**
 * Why a source fetch failed.
 * transient: retry next sweep, permanent: disable with reason, quota: pause YouTube refresh.
 */
export type FailureKind = 'transient' | 'permanent' | 'quota';

/** Error carrying a failure kind so callers can map it onto retry and disable behavior. */
export class PlatformError extends Error {
  readonly failure: FailureKind;

  constructor(failure: FailureKind, message: string) {
    super(message);
    this.failure = failure;
  }
}

export type FetchResult =
  | Stats
  | { failure: FailureKind; message: string };

export type ResolveResult =
  | { sourceId: string; sourceName: string }
  | { failure: FailureKind | 'not-found' | 'invalid'; message: string };

export interface PlatformProvider {
  readonly platform: Platform;
  /** Platform-native id for a classified input. */
  resolveSource(kind: SourceKind, value: string): Promise<ResolveResult>;
  /** Batch fetch keyed by source id. Dead sources come back as failed entries, partial stats are allowed. */
  fetchStats(sourceIds: string[]): Promise<Map<string, FetchResult>>;
}
