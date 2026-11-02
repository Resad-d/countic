import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { selectPanel, updatePanelSource } from '../../db/queries.js';
import { classify } from '../../lib/counters/classify.js';
import { PLATFORMS, PlatformError, type Platform, type ResolveResult } from '../../lib/counters/platform-types.js';
import { config } from '../../lib/config.js';
import { resolutionAllowed, spend } from '../../lib/quota.js';
import { en, tr } from '../../lib/i18n/index.js';
import { resolveFailureMessage } from './setup.js';
import type { CommandDef } from './index.js';

export const setChannel: CommandDef = {
  data: new SlashCommandBuilder()
    .setName('set-channel')
    .setDescription(en['cmd.setchannel.desc'])
    .setDescriptionLocalization('tr', tr['cmd.setchannel.desc'])
    .addStringOption((option) =>
      option
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
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('channel')
        .setDescription(en['option.channel'])
        .setDescriptionLocalization('tr', tr['option.channel'])
        .setRequired(true),
    )
    .setContexts(InteractionContextType.Guild),
  descKey: 'cmd.setchannel.desc',
  cooldownSeconds: 15,
  requiredPerm: PermissionFlagsBits.ManageChannels,
  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(ctx.t('common.error'));
      return;
    }
    const platform = interaction.options.getString('platform', true) as Platform;
    const input = interaction.options.getString('channel', true);
    const label = ctx.t(`platform.${platform}`);
    const provider = ctx.providers[platform];
    if (!provider) {
      await interaction.editReply(ctx.t('setup.missingProvider', { platform: label }));
      return;
    }
    const panelRow = await selectPanel(guildId, platform);
    if (!panelRow) {
      await interaction.editReply(ctx.t('panel.none', { platform: label }));
      return;
    }
    const classified = classify(platform, input);
    if (!classified) {
      await interaction.editReply(ctx.t('setup.invalidSource', { source: input, platform: label }));
      return;
    }
    if (!(await resolutionAllowed(guildId))) {
      await interaction.editReply(ctx.t('common.resolutionCap', { limit: config.RESOLUTION_DAILY_PER_GUILD }));
      return;
    }
    // Only youtube draws from the quota meter, twitch and kick are free.
    if (platform === 'youtube' && !(await spend('channels_list', 'resolution', 1))) {
      await interaction.editReply(ctx.t('common.quotaExhausted'));
      return;
    }
    let resolved: ResolveResult;
    try {
      resolved = await provider.resolveSource(classified.kind, classified.value);
    } catch (err) {
      // Source failures throw, input misses come back as values.
      if (err instanceof PlatformError) {
        await interaction.editReply(resolveFailureMessage(ctx.t, input, platform, err.failure));
        return;
      }
      throw err;
    }
    if ('failure' in resolved) {
      await interaction.editReply(resolveFailureMessage(ctx.t, input, platform, resolved.failure));
      return;
    }
    await updatePanelSource(panelRow.id, resolved.sourceId, resolved.sourceName);
    const content = ctx.t('setchannel.success', { source: resolved.sourceName });
    await interaction.editReply(ctx.t('common.done'));
    await interaction.followUp({ content: `${content}\n-# ${ctx.t('common.requestedBy', { user: interaction.user.username })}` });
  },
};
