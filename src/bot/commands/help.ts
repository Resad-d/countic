import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type Client,
} from 'discord.js';
import { en, tr } from '../../lib/i18n/index.js';
import type { CommandDef } from './index.js';

/**
 * Application command ids by name, for the clickable mentions in the field titles.
 * Filled from the registration response on shard 0, other shards fetch lazily.
 */
const commandIds = new Map<string, string>();
let idsFetched = false;

export function storeCommandIds(commands: readonly { id: string; name: string }[]): void {
  for (const command of commands) {
    commandIds.set(command.name, command.id);
  }
}

async function commandMention(client: Client, name: string, sub?: string): Promise<string | null> {
  let id = commandIds.get(name);
  if (!id && !idsFetched) {
    try {
      const application = client.application;
      if (application) {
        for (const command of (await application.commands.fetch()).values()) {
          commandIds.set(command.name, command.id);
        }
        idsFetched = true;
      }
    } catch {
      // Mentions are cosmetic, plain text fallback is fine.
    }
    id = commandIds.get(name);
  }
  return id ? `</${name}${sub ? ` ${sub}` : ''}:${id}>` : null;
}

// Subcommand names for the field title, minus the one the pill already shows.
function subSuffix(data: ReturnType<SlashCommandBuilder['toJSON']>, skip?: string): string {
  const subs = (data.options ?? [])
    .filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
    .filter((option) => option.name !== skip)
    .map((option) => `\`${option.name}\``);
  return subs.length > 0 ? ` ${subs.join('/')}` : '';
}

export const help: CommandDef = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription(en['cmd.help.desc'])
    .setDescriptionLocalization('tr', tr['cmd.help.desc'])
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 0,
  requiredPerm: null,
  descKey: 'cmd.help.desc',
  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder().setColor(0x5865f2).setDescription(ctx.t('help.intro'));
    const botUser = interaction.client.user;
    if (botUser) {
      embed.setAuthor({ name: ctx.t('help.title'), iconURL: botUser.displayAvatarURL() });
    }
    const listed = ctx.commands.filter((command) => command.data.name !== 'help');
    for (const [index, command] of listed.entries()) {
      const data = command.data.toJSON();
      const firstSub = (data.options ?? []).find(option => option.type === ApplicationCommandOptionType.Subcommand)?.name;
      const mention = await commandMention(interaction.client, data.name, firstSub);
      const title = `${mention ?? `/${data.name}`}${subSuffix(data, firstSub)}`;
      embed.addFields({ name: title, value: ctx.t(command.descKey), inline: true });
      // Inline fields pack 3 per row, a non-inline blank field keeps them 2 per row.
      if ((index + 1) % 2 === 0 && index + 1 < listed.length) {
        embed.addFields({ name: '\u200B', value: '\u200B' });
      }
    }
    embed.setFooter({ text: ctx.t('help.footer') });
    await interaction.editReply({ embeds: [embed] });
  },
};
