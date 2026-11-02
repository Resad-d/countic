import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandStringOption,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedField,
} from 'discord.js';
import { deleteCounterRow, selectCountersWithReasons, selectPanel, type PanelRow } from '../../db/queries.js';
import { COUNTER_TYPES, PLATFORMS, type Platform } from '../../lib/counters/platform-types.js';
import { deleteChannelsBestEffort, teardownPanel } from '../panels.js';
import { counterText, en, resolveLocale, tr, translator, type Translator } from '../../lib/i18n/index.js';
import { counterPreview, type CommandContext, type CommandDef } from './index.js';

function platformOption(): SlashCommandStringOption {
  return new SlashCommandStringOption()
    .setName('platform')
    .setDescription(en['option.platform'])
    .setDescriptionLocalization('tr', tr['option.platform'])
    .addChoices(
      ...PLATFORMS.map((platform) => ({
        name: en[`platform.${platform}`],
        value: platform,
        name_localizations: { tr: tr[`platform.${platform}`] },
      })),
    )
    .setRequired(true);
}

// The custom id carries the deadline and scope, re-renders pass the same values back.
function deleteRow(
  platform: Platform,
  scope: string,
  userId: string,
  expires: number,
  t: Translator,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel:delete:${platform}:${userId}:${expires}:${scope}:confirm`)
      .setLabel(t('common.confirm'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`panel:delete:${platform}:${userId}:${expires}:${scope}:cancel`)
      .setLabel(t('common.cancel'))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

// Source page link, plain text fallback when no link can be built.
function sourceLink(platform: Platform, sourceId: string | null, sourceName: string | null, fallback: string): string {
  const label = sourceName ?? sourceId;
  if (!label) {
    return fallback;
  }
  if (!sourceId) {
    return `\`${label}\``;
  }
  const url =
    platform === 'youtube'
      ? `https://youtube.com/channel/${sourceId}`
      : platform === 'twitch'
        ? `https://twitch.tv/${sourceName ?? sourceId}`
        : `https://kick.com/${sourceName ?? sourceId}`;
  return `[${label}](${url})`;
}

async function statusEmbed(
  ctx: CommandContext,
  panelRow: PanelRow,
  interaction: ChatInputCommandInteraction,
): Promise<EmbedBuilder> {
  const { t } = ctx;
  const counters = await selectCountersWithReasons([panelRow.id]);
  const locale = interaction.guild?.preferredLocale ?? 'en';
  const stats = panelRow.lastStats
    ? { sourceName: panelRow.sourceName ?? '', values: panelRow.lastStats }
    : null;
  const mark = panelRow.enabled ? '✅' : '⛔';
  const state = `\`${mark}\` ${t(panelRow.enabled ? 'common.enabled' : 'common.disabled')}`;
  const fields: EmbedField[] = [
    {
      name: t('panel.statusState'),
      value: `${state}${panelRow.reason ? `\n${t('panel.statusReason')}: ${panelRow.reason}` : ''}`,
      inline: true,
    },
    {
      name: t('panel.statusSource'),
      value: sourceLink(panelRow.platform, panelRow.sourceId, panelRow.sourceName, t('common.none')),
      inline: true,
    },
    {
      name: t('panel.statusLastUpdate'),
      value: panelRow.lastCheckedAt ? `<t:${Math.floor(panelRow.lastCheckedAt.getTime() / 1000)}:R>` : t('panel.never'),
      inline: true,
    },
  ];
  // Blank row separating the summary from the counter list.
  fields.push({ name: '\u200B', value: '\u200B', inline: false });
  for (const counter of counters) {
    const mark = counter.enabled ? '✅' : '⛔';
    const input = { type: counter.type, template: counter.template, numberFormat: counter.numberFormat };
    const preview = counterPreview(input, panelRow.platform, stats, locale);
    const reason = counter.reason ? `\n\`⚠️\` ${counter.reason}` : '';
    const target =
      counter.type === 'category'
        ? `\`${interaction.guild?.channels.cache.get(counter.channelId)?.name ?? t('common.none')}\``
        : `<#${counter.channelId}>`;
    fields.push({
      name: counterText(t, counter.type),
      value: `\`${mark}\` ${target}\n\`${preview}\`${reason}`,
      inline: counter.type !== 'category',
    });
  }
  return new EmbedBuilder()
    .setColor(panelRow.enabled ? 0x57f287 : 0xed4245)
    .setTitle(t('panel.statusTitle', { platform: t(`platform.${panelRow.platform}`) }))
    .setAuthor({ name: interaction.guild?.name ?? '', iconURL: interaction.guild?.iconURL() ?? undefined })
    .addFields(fields)
    .setTimestamp();
}

// The /panel status overview, one field per platform.
async function overviewEmbed(ctx: CommandContext, interaction: ChatInputCommandInteraction): Promise<EmbedBuilder> {
  const { t } = ctx;
  const embed = new EmbedBuilder()
    .setColor(0x1896c5)
    .setTitle(t('panel.overviewTitle'))
    .setAuthor({ name: interaction.guild?.name ?? '', iconURL: interaction.guild?.iconURL() ?? undefined });
  const guildId = interaction.guildId;
  if (!guildId) {
    return embed;
  }
  for (const platform of ['youtube', 'twitch', 'kick'] as Platform[]) {
    const panelRow = await selectPanel(guildId, platform);
    const lines: string[] = [];
    if (panelRow) {
      const mark = panelRow.enabled ? '✅' : '⛔';
      const updated = panelRow.lastCheckedAt
        ? `<t:${Math.floor(panelRow.lastCheckedAt.getTime() / 1000)}:R>`
        : t('panel.never');
      lines.push(`\`${mark}\` ${sourceLink(platform, panelRow.sourceId, panelRow.sourceName, t('panel.noSource'))}`);
      lines.push(`${t('panel.statusLastUpdate')}: ${updated}`);
      if (panelRow.reason) {
        lines.push(`\`⚠️\` ${t('panel.statusReason')}: ${panelRow.reason}`);
      }
    } else {
      lines.push(t('panel.noSource'));
    }
    embed.addFields({ name: t(`platform.${platform}`), value: lines.join('\n'), inline: true });
  }
  embed.setTimestamp();
  return embed;
}

export const panel: CommandDef = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription(en['cmd.panel.desc'])
    .setDescriptionLocalization('tr', tr['cmd.panel.desc'])
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription(en['cmd.panel.status.desc'])
        .addStringOption(platformOption().setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription(en['cmd.panel.delete.desc'])
        .addStringOption(platformOption)
        .addStringOption((option) =>
          option
            .setName('counter')
            .setDescription(en['option.counter'])
            .setDescriptionLocalization('tr', tr['option.counter'])
            .addChoices(
              ...COUNTER_TYPES.map((type) => ({
                name: en[`counter.${type}`],
                value: type,
                name_localizations: { tr: tr[`counter.${type}`] },
              })),
            ),
        ),
    )
    .setContexts(InteractionContextType.Guild),
  descKey: 'cmd.panel.desc',
  cooldownSeconds: 15,
  requiredPerm: PermissionFlagsBits.ManageChannels,
  buttons: [
    {
      prefix: 'panel:delete:',
      perm: PermissionFlagsBits.ManageChannels,
      handle: handlePanelButton,
    },
  ],
  async execute(interaction, ctx) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: ctx.t('common.error'), flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand(true);
    if (sub === 'status' && !interaction.options.getString('platform')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ embeds: [await overviewEmbed(ctx, interaction)] });
      return;
    }
    const platform = interaction.options.getString('platform', true) as Platform;
    const label = ctx.t(`platform.${platform}`);
    const panelRow = await selectPanel(guildId, platform);
    if (!panelRow) {
      await interaction.reply({ content: ctx.t('panel.none', { platform: label }), flags: MessageFlags.Ephemeral });
      return;
    }
    if (sub === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ embeds: [await statusEmbed(ctx, panelRow, interaction)] });
      return;
    }
    const counters = await selectCountersWithReasons([panelRow.id]);
    const scope = interaction.options.getString('counter');
    if (scope === 'category') {
      await interaction.reply({ content: ctx.t('panel.categoryScope'), flags: MessageFlags.Ephemeral });
      return;
    }
    const target = scope ? counters.find((entry) => entry.type === scope) : undefined;
    if (scope && !target) {
      // The counter choices are platform independent, so a wrong pick lands here.
      const valid = counters.map((entry) => counterText(ctx.t, entry.type)).join(', ');
      await interaction.reply({
        content: ctx.t('customize.counterWrongPlatform', { counter: counterText(ctx.t, scope), platform: label, valid }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    if (target) {
      await interaction.editReply({
        content: ctx.t('panel.counterConfirm', { counter: counterText(ctx.t, target.type), platform: label }),
        components: [deleteRow(platform, target.type, interaction.user.id, Date.now() + 30_000, ctx.t)],
      });
      return;
    }
    await interaction.editReply({
      content: ctx.t('panel.deleteConfirm', { platform: label, count: counters.length }),
      components: [deleteRow(platform, 'all', interaction.user.id, Date.now() + 30_000, ctx.t)],
    });
  },
};

async function handlePanelButton(interaction: ButtonInteraction): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    return;
  }
  const t = translator(resolveLocale(interaction.locale));
  // panel:delete:<platform>:<userId>:<expires>:<scope>:<action>
  const parts = interaction.customId.split(':');
  const platform = parts[2];
  const userId = parts[3];
  const expires = Number(parts[4]);
  const scope = parts[5];
  const action = parts[6];
  if (
    (platform !== 'youtube' && platform !== 'twitch' && platform !== 'kick') ||
    !Number.isInteger(expires)
  ) {
    return;
  }
  if (Date.now() > expires) {
    await interaction.update({
      content: t('common.expired'),
      components: [deleteRow(platform, scope, userId, expires, t, true)],
    });
    return;
  }
  if (userId !== interaction.user.id) {
    await interaction.reply({ content: t('common.promptOther'), flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === 'cancel') {
    await interaction.update({
      content: t('common.cancelled'),
      components: [deleteRow(platform, scope, userId, expires, t, true)],
    });
    return;
  }
  if (action !== 'confirm') {
    return;
  }
  const panelRow = await selectPanel(guildId, platform);
  if (!panelRow) {
    await interaction.update({
      content: t('common.expired'),
      components: [deleteRow(platform, scope, userId, expires, t, true)],
    });
    return;
  }
  await interaction.deferUpdate();
  if (scope !== 'all') {
    const counters = await selectCountersWithReasons([panelRow.id]);
    const counter = counters.find((entry) => entry.type === scope);
    if (!counter) {
      await interaction.editReply({ content: t('common.expired'), components: [] });
      return;
    }
    const leftover = await deleteChannelsBestEffort(guild, [counter.channelId]);
    await deleteCounterRow(panelRow.id, scope);
    const content =
      leftover > 0
        ? t('panel.counterLeftover', { counter: counterText(t, scope) })
        : t('panel.counterDeleted', { counter: counterText(t, scope) });
    await interaction.editReply({ content, components: [] });
    return;
  }
  const { counterCount, leftover } = await teardownPanel(guild, panelRow);
  if (leftover > 0) {
    await interaction.editReply({ content: t('panel.deleteLeftovers', { count: leftover }), components: [] });
  } else {
    await interaction.editReply({ content: t('panel.deleted', { count: counterCount }), components: [] });
  }
}
