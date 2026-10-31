import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { counterName } from '../../lib/counters/names.js';
import { DEFAULT_TEMPLATES } from '../../lib/counters/templates.js';
import { customize } from './customize.js';
import { help } from './help.js';
import { panel } from './panel.js';
import { setChannel } from './setchannel.js';
import { setup } from './setup.js';
import type { Platform, PlatformProvider } from '../../lib/counters/platform-types.js';
import type { CatalogKey, Locale, Translator } from '../../lib/i18n/index.js';

/** Command contracts, shared view helpers and the registry consumed by the router. */

export type Providers = Partial<Record<Platform, PlatformProvider>>;

export type CommandContext = {
  client: Client;
  providers: Providers;
  commands: CommandDef[];
  locale: Locale;
  t: Translator;
};

/** A Discord permission bit, or null when none is needed. */
export type Perm = (typeof PermissionFlagsBits)[keyof typeof PermissionFlagsBits] | null;

export type CommandDef = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
  descKey: CatalogKey;
  cooldownSeconds: number;
  requiredPerm: Perm;
  /** Buttons and modals this command created, matched by customId prefix in the router. */
  buttons?: ButtonHandler[];
  modals?: ModalHandler[];
  execute: (interaction: ChatInputCommandInteraction, ctx: CommandContext) => Promise<void>;
};

/** A button or modal flow owned by the command file that created it. */
type ComponentHandler = {
  /** customId prefix this entry owns. */
  prefix: string;
  /** Checked by the router before the handler runs. */
  perm: Perm;
};

export type ButtonHandler = ComponentHandler & {
  handle: (interaction: ButtonInteraction) => Promise<void>;
};

export type ModalHandler = ComponentHandler & {
  handle: (interaction: ModalSubmitInteraction) => Promise<void>;
};

/**
 * Rendered counter name for the status and customize views.
 * Before the first scheduler tick there are no numbers, so the raw template shows.
 */
export function counterPreview(
  counter: { type: string; template: string | null; numberFormat: 'compact' | 'full' },
  platform: Platform,
  stats: { sourceName: string; values: Partial<Record<string, number>> } | null,
  locale: string,
): string {
  if (stats) {
    const rendered = counterName(counter, platform, stats, locale);
    if (rendered !== null) {
      return rendered;
    }
  }
  const defaults = DEFAULT_TEMPLATES[platform] as Partial<Record<string, string>>;
  return counter.template ?? defaults[counter.type] ?? '';
}

export const userCommands: CommandDef[] = [setup, panel, setChannel, customize, help];
export const buttonHandlers: ButtonHandler[] = userCommands.flatMap((command) => command.buttons ?? []);
export const modalHandlers: ModalHandler[] = userCommands.flatMap((command) => command.modals ?? []);
