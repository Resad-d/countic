import { counterNameLength } from './names.js';
import { COUNTER_TYPES, type CounterType, type Platform, type StatKey } from './platform-types.js';

/**
 * Default counter templates.
 * [name] is the source name, stat placeholders use the counter type key.
 */
export const DEFAULT_TEMPLATES: Record<Platform, Partial<Record<CounterType, string>>> = {
  youtube: {
    category: '[name] • YouTube',
    subs: 'Subs: [subs]',
    views: 'Views: [views]',
    videos: 'Videos: [videos]',
  },
  twitch: {
    category: '[name] • Twitch',
    followers: 'Followers: [followers]',
    viewers: 'Viewers: [viewers]',
  },
  kick: {
    category: '[name] • Kick',
    followers: 'Followers: [followers]',
    viewers: 'Viewers: [viewers]',
  },
};

/** Shown for twitch and kick viewers counters while the stream is offline. */
export const OFFLINE_LABEL = 'Offline';

/** Shown before a counter has any fetched numbers, until the first update lands. */
export const PENDING_LABEL = '...';

/** Number format a fresh counter starts on. */
export function defaultNumberFormat(type: string): 'compact' | 'full' {
  return type === 'subs' || type === 'followers' ? 'compact' : 'full';
}

export type TemplateCheck =
  | { ok: true; template: string | null }
  | { ok: false; code: 'need-placeholder' | 'category-no-stats' | 'too-long'; placeholder?: string; length?: number };

/**
 * Validates a user supplied template against the placeholder and length rules.
 * An empty candidate means reset to the default and comes back as null.
 */
export function validateTemplate(
  platform: Platform,
  type: string,
  candidate: string,
  numberFormat: 'compact' | 'full',
  locale: string,
): TemplateCheck {
  if (candidate.length === 0) {
    return { ok: true, template: null };
  }
  if (type === 'category') {
    if (!candidate.includes('[name]')) {
      return { ok: false, code: 'need-placeholder', placeholder: '[name]' };
    }
    if (new RegExp(`\\[(${COUNTER_TYPES.join('|')})\\]`).test(candidate)) {
      return { ok: false, code: 'category-no-stats' };
    }
  } else if (!candidate.includes(`[${type}]`)) {
    return { ok: false, code: 'need-placeholder', placeholder: `[${type}]` };
  }
  // The rendered name is longer than the template, so measure with a wide sample value.
  const sample = {
    sourceName: 'Sample',
    values: (type === 'category' ? {} : { [type]: 1234567890 }) as Partial<Record<StatKey, number>>,
  };
  const length = counterNameLength({ type, template: candidate, numberFormat }, platform, sample, locale);
  if (length > 100) {
    return { ok: false, code: 'too-long', length };
  }
  return { ok: true, template: candidate };
}
