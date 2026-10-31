import { childLogger } from '../logger.js';
import { COUNTER_TYPES } from '../counters/platform-types.js';
import { en, type Catalog } from './en.js';
import { tr } from './tr.js';

export { en, tr };

/** Typed message catalogs with {param} interpolation and english fallback. */

const log = childLogger('i18n');

const catalogs = { en, tr };

export type Locale = keyof typeof catalogs;
export type CatalogKey = keyof Catalog;
export type Translator = (key: CatalogKey, params?: Record<string, string | number>) => string;

export function resolveLocale(discordLocale: string | null | undefined): Locale {
  // en-US and en-GB both map to the single english catalog.
  return discordLocale === 'tr' ? 'tr' : 'en';
}

export function translator(locale: Locale): Translator {
  return (key, params) => {
    const template = catalogs[locale][key];
    if (!params) {
      return template;
    }
    const text = template.replace(/\{(\w+)\}/g, (match, param: string) =>
      param in params ? String(params[param]) : match,
    );
    const leftover = /\{\w+\}/.exec(text);
    if (leftover) {
      log.warn({ key, leftover: leftover[0] }, 'message params missing');
    }
    return text;
  };
}

// counter.type comes from the DB, unknown types render as-is.
export function counterText(t: Translator, type: string): string {
  return (COUNTER_TYPES as readonly string[]).includes(type) ? t(`counter.${type}` as CatalogKey) : type;
}
