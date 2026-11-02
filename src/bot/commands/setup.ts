import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { createPanelRows, selectCountersWithReasons, selectPanel, type PanelCounterFull } from '../../db/queries.js';
import { classify } from '../../lib/counters/classify.js';
import { PLATFORMS, PlatformError, type FailureKind, type Platform, type ResolveResult } from '../../lib/counters/platform-types.js';
import { config } from '../../lib/config.js';
import { en, resolveLocale, tr, translator, type Translator } from '../../lib/i18n/index.js';
import { childLogger } from '../../lib/logger.js';
import {
  canManageChannels,
  createPanelChannels,
  deleteChannelsBestEffort,
  teardownPanel,
  type CreatedCounter,
} from '../panels.js';
import { resolutionAllowed, spend } from '../../lib/quota.js';
import type { CommandDef } from './index.js';

const log = childLogger('setup');

type PreparedPanel = {
  platform: Platform;
  sourceId: string;
  sourceName: string;
  /** Old counter templates and formats, carried onto the replacement panel by type. */
  carryOver?: Pick<PanelCounterFull, 'type' | 'template' | 'numberFormat'>[];
};

// Replace confirmations expire after 30 seconds, one per guild, pruned lazily so the map stays bounded.
const pending = new Map<string, PreparedPanel & { userId: string; expires: number }>();

function stashPending(guildId: string, entry: PreparedPanel & { userId: string }): void {
  const now = Date.now();
  if (pending.size > 200) {
    for (const [key, value] of pending) {
      if (value.expires <= now) {
        pending.delete(key);
      }
    }
  }
  pending.set(guildId, { ...entry, expires: now + 30_000 });
}

// The deferred reply is public so panel changes are visible, problems stay ephemeral.
// deleteReply clears the public thinking placeholder the defer created.
async function failEphemeral(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
  await interaction.deleteReply().catch(() => {});
}

export function resolveFailureMessage(
  t: Translator,
  source: string,
  platform: Platform,
  failure: FailureKind | 'not-found' | 'invalid',
): string {
  if (failure === 'quota') {
    return t('common.quotaExhausted');
  }
  // Temporary problems get a retry message, permanent ones mean the source is wrong.
  if (failure === 'transient') {
    return t('setup.fetchFailed', { platform: t(`platform.${platform}`) });
  }
  return t('setup.invalidSource', { source, platform: t(`platform.${platform}`) });
}

function replaceRow(t: Translator, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:replace:confirm')
      .setLabel(t('common.confirm'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('setup:replace:cancel')
      .setLabel(t('common.cancel'))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

async function buildPanel(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  t: Translator,
  guild: Guild,
  prepared: PreparedPanel,
  extraNote?: string,
): Promise<void> {
  if (!canManageChannels(guild)) {
    await interaction.editReply({ content: t('setup.botNoPerms'), components: [] });
    return;
  }
  const created: CreatedCounter[] = [];
  try {
    const channels = await createPanelChannels(guild, prepared.platform, prepared.sourceName);
    created.push(...channels);
    await createPanelRows({
      guildId: guild.id,
      platform: prepared.platform,
      sourceId: prepared.sourceId,
      sourceName: prepared.sourceName,
      counters: channels.map((counter) => ({ type: counter.type, channelId: counter.channelId })),
      carryOver: prepared.carryOver,
    });
  } catch (err) {
    log.error({ err, guildId: guild.id }, 'panel creation failed');
    await deleteChannelsBestEffort(guild, created.map((counter) => counter.channelId));
    await interaction.editReply({ content: t('setup.failed'), components: [] });
    return;
  }
  await interaction.editReply({
    content: `${t('setup.created', { source: prepared.sourceName })}${extraNote ? `\n${extraNote}` : ''}`,
    embeds: [
      new EmbedBuilder().addFields(
        { name: t('panel.statusSource'), value: `\`${prepared.sourceName}\`` },
        { name: t('setup.counters'), value: created.map((counter) => `\`${counter.name}\``).join('\n') },
      ),
    ],
    components: [],
  });
}

export const setup: CommandDef = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription(en['cmd.setup.desc'])
    .setDescriptionLocalization('tr', tr['cmd.setup.desc'])
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
  descKey: 'cmd.setup.desc',
  cooldownSeconds: 15,
  requiredPerm: PermissionFlagsBits.ManageChannels,
  buttons: [
    {
      prefix: 'setup:replace:',
      perm: PermissionFlagsBits.ManageChannels,
      handle: handleSetupButton,
    },
  ],
  async execute(interaction, ctx) {
    // Public defer so the created panel announcement is visible, problems stay ephemeral.
    await interaction.deferReply();
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    if (!guild || !guildId) {
      await failEphemeral(interaction, ctx.t('common.error'));
      return;
    }
    const platform = interaction.options.getString('platform', true) as Platform;
    const input = interaction.options.getString('channel', true);
    const label = ctx.t(`platform.${platform}`);
    const provider = ctx.providers[platform];
    if (!provider) {
      await failEphemeral(interaction, ctx.t('setup.missingProvider', { platform: label }));
      return;
    }
    const classified = classify(platform, input);
    if (!classified) {
      await failEphemeral(interaction, ctx.t('setup.invalidSource', { source: input, platform: label }));
      return;
    }
    if (!(await resolutionAllowed(guildId))) {
      await failEphemeral(interaction, ctx.t('common.resolutionCap', { limit: config.RESOLUTION_DAILY_PER_GUILD }));
      return;
    }
    // Only youtube draws from the quota meter, twitch and kick are free.
    if (platform === 'youtube' && !(await spend('channels_list', 'resolution', 1))) {
      await failEphemeral(interaction, ctx.t('common.quotaExhausted'));
      return;
    }
    let resolved: ResolveResult;
    try {
      resolved = await provider.resolveSource(classified.kind, classified.value);
    } catch (err) {
      // Source failures throw, input misses come back as values.
      if (err instanceof PlatformError) {
        await failEphemeral(interaction, resolveFailureMessage(ctx.t, input, platform, err.failure));
        return;
      }
      throw err;
    }
    if ('failure' in resolved) {
      await failEphemeral(interaction, resolveFailureMessage(ctx.t, input, platform, resolved.failure));
      return;
    }
    const existing = await selectPanel(guildId, platform);
    if (existing) {
      const oldCounters = await selectCountersWithReasons([existing.id]);
      if (
        existing.sourceId === resolved.sourceId &&
        oldCounters.every((counter) => guild.channels.cache.has(counter.channelId))
      ) {
        await failEphemeral(interaction, ctx.t('setup.alreadyTracked'));
        return;
      }
      stashPending(guildId, {
        userId: interaction.user.id,
        platform,
        sourceId: resolved.sourceId,
        sourceName: resolved.sourceName,
        carryOver: oldCounters,
      });
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(ctx.t('setup.replaceTitle'))
            .setDescription(
              ctx.t('setup.replaceDesc', {
                platform: label,
                current: existing.sourceName ?? existing.sourceId ?? '?',
                source: resolved.sourceName,
              }),
            ),
        ],
        components: [replaceRow(ctx.t)],
      });
      return;
    }
    await buildPanel(interaction, ctx.t, guild, { platform, sourceId: resolved.sourceId, sourceName: resolved.sourceName });
  },
};

async function handleSetupButton(interaction: ButtonInteraction): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    return;
  }
  const t = translator(resolveLocale(interaction.locale));
  const entry = pending.get(guildId);
  if (entry && entry.userId !== interaction.user.id && entry.expires > Date.now()) {
    await interaction.reply({ content: t('common.promptOther'), flags: MessageFlags.Ephemeral });
    return;
  }
  if (!entry || entry.expires <= Date.now()) {
    pending.delete(guildId);
    await interaction.update({ content: t('common.expired'), embeds: [], components: [replaceRow(t, true)] });
    return;
  }
  pending.delete(guildId);
  if (interaction.customId.endsWith('cancel')) {
    await interaction.update({ content: t('common.cancelled'), embeds: [], components: [replaceRow(t, true)] });
    return;
  }
  await interaction.deferUpdate();
  const existing = await selectPanel(guildId, entry.platform);
  let leftover = 0;
  if (existing) {
    ({ leftover } = await teardownPanel(guild, existing));
  }
  const note = leftover > 0 ? t('panel.deleteLeftovers', { count: leftover }) : undefined;
  await buildPanel(interaction, t, guild, entry, note);
}
