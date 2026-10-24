import type { Platform, SourceKind } from './platform-types.js';

/** Turns free user input into a typed source reference. Pure string work, no network. */

export type ClassifiedInput = { kind: SourceKind; value: string };

const YT_CHANNEL_ID = /^UC[\w-]{22}$/;
const TWITCH_LOGIN = /^[a-zA-Z0-9_]{3,25}$/;
const KICK_SLUG = /^[a-z0-9_]{2,25}$/;

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv']);
const KICK_HOSTS = new Set(['kick.com', 'www.kick.com']);

// Path prefixes that are never channel names, so pasted non-channel URLs fail cleanly.
const NON_CHANNEL_SEGMENTS = new Set([
  'videos', 'video', 'clip', 'clips', 'directory', 'search', 'settings', 'downloads', 'categories',
]);

export function classify(platform: Platform, input: string): ClassifiedInput | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }
  if (platform === 'youtube') {
    return classifyYoutube(raw);
  }
  if (platform === 'twitch') {
    return classifyTwitch(raw);
  }
  return classifyKick(raw);
}

function classifyYoutube(raw: string): ClassifiedInput | null {
  if (raw.startsWith('@')) {
    const handle = raw.slice(1);
    return /^[\w.-]{3,30}$/.test(handle) ? { kind: 'youtube-handle', value: handle } : null;
  }
  if (YT_CHANNEL_ID.test(raw)) {
    return { kind: 'youtube-id', value: raw };
  }

  const url = toUrl(raw);
  if (!url || !YT_HOSTS.has(url.hostname)) {
    return null;
  }
  const segments = pathSegments(url);
  const [head, tail] = segments;
  if (!head) {
    return null;
  }
  if (!tail) {
    // youtube.com/@handle ships the handle as one segment.
    if (head.startsWith('@') && /^[\w.-]{3,30}$/.test(head.slice(1))) {
      return { kind: 'youtube-handle', value: head.slice(1) };
    }
    return null;
  }
  if (head === 'channel' && YT_CHANNEL_ID.test(tail)) {
    return { kind: 'youtube-id', value: tail };
  }
  if (head === 'user' || head === 'c') {
    return { kind: 'youtube-username', value: tail };
  }
  return null;
}

function classifyTwitch(raw: string): ClassifiedInput | null {
  const url = toUrl(raw);
  if (url) {
    if (!TWITCH_HOSTS.has(url.hostname)) {
      return null;
    }
    const [head] = pathSegments(url);
    if (!head || NON_CHANNEL_SEGMENTS.has(head)) {
      return null;
    }
    return validLogin(head) ? { kind: 'twitch-login', value: head.toLowerCase() } : null;
  }
  const name = raw.startsWith('@') ? raw.slice(1) : raw;
  return validLogin(name) ? { kind: 'twitch-login', value: name.toLowerCase() } : null;
}

function classifyKick(raw: string): ClassifiedInput | null {
  const url = toUrl(raw);
  if (url) {
    if (!KICK_HOSTS.has(url.hostname)) {
      return null;
    }
    const [head] = pathSegments(url);
    if (!head || NON_CHANNEL_SEGMENTS.has(head)) {
      return null;
    }
    return validKickSlug(head) ? { kind: 'kick-slug', value: head.toLowerCase() } : null;
  }
  const name = raw.startsWith('@') ? raw.slice(1) : raw;
  return validKickSlug(name) ? { kind: 'kick-slug', value: name.toLowerCase() } : null;
}

function validLogin(name: string): boolean {
  return TWITCH_LOGIN.test(name);
}

function validKickSlug(name: string): boolean {
  return KICK_SLUG.test(name);
}

function toUrl(raw: string): URL | null {
  const candidate = raw.includes('://') ? raw : raw.includes('.') ? `https://${raw}` : null;
  if (!candidate) {
    return null;
  }
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}
