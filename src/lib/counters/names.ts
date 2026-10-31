import { formatCount } from './format.js';
import type { Platform } from './platform-types.js';
import { renderTemplate } from './render.js';
import { DEFAULT_TEMPLATES, OFFLINE_LABEL, PENDING_LABEL } from './templates.js';

/** One rendered counter channel name, shared by the scheduler and the bot layer. */

type CounterNameInput = {
  type: string;
  template: string | null;
  numberFormat: 'compact' | 'full';
};

type StatsShape = { sourceName: string; values: Partial<Record<string, number>> };

const MAX_NAME_LENGTH = 100;

// Unclipped render behind both helpers, callers decide between the string and its length.
function renderUnclipped(
  counter: CounterNameInput,
  platform: Platform,
  stats: StatsShape | null,
  locale: string,
): string | null {
  const defaults = DEFAULT_TEMPLATES[platform] as Partial<Record<string, string>>;
  const template = counter.template ?? defaults[counter.type];
  if (!template) {
    return null;
  }
  const raw = counter.type === 'category' ? undefined : stats?.values[counter.type];
  // Null stats means not fetched yet, a missing value in real stats means the stream is offline.
  const value = raw === undefined ? (stats === null ? PENDING_LABEL : OFFLINE_LABEL) : formatCount(raw, counter.numberFormat, locale);
  return renderTemplate(template, { name: stats?.sourceName ?? '', [counter.type]: value });
}

/**
 * Rendered channel name for a counter, or null when the platform has no template for it.
 * locale is any Intl locale string.
 */
export function counterName(
  counter: CounterNameInput,
  platform: Platform,
  stats: StatsShape | null,
  locale: string,
): string | null {
  return renderUnclipped(counter, platform, stats, locale)?.slice(0, MAX_NAME_LENGTH) ?? null;
}

/** Unclipped length of a rendered name, used by template validation. */
export function counterNameLength(
  counter: CounterNameInput,
  platform: Platform,
  stats: StatsShape | null,
  locale: string,
): number {
  return renderUnclipped(counter, platform, stats, locale)?.length ?? 0;
}
