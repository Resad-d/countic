import type { CounterType, Platform } from './platform-types.js';

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
