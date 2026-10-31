import {
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandStringOption,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  selectCounterById,
  selectCountersWithReasons,
  selectPanel,
  setCounterFormat,
  setCounterTemplate,
} from '../../db/queries.js';
import { counterNameLength } from '../../lib/counters/names.js';
import { COUNTER_TYPES, PLATFORMS, type Platform, type StatKey } from '../../lib/counters/platform-types.js';
import { DEFAULT_TEMPLATES } from '../../lib/counters/templates.js';
import { counterText, en, resolveLocale, tr, translator } from '../../lib/i18n/index.js';
import { counterPreview, type CommandDef } from './index.js';

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

function counterOption(): SlashCommandStringOption {
  return new SlashCommandStringOption()
    .setName('counter')
    .setDescription(en['option.counter'])
    .setDescriptionLocalization('tr', tr['option.counter'])
    .addChoices(
      ...COUNTER_TYPES.map((type) => ({
        name: en[`counter.${type}`],
        value: type,
        name_localizations: { tr: tr[`counter.${type}`] },
      })),
    )
    .setRequired(true);
}

export const customize: CommandDef = {
  data: new SlashCommandBuilder()
    .setName('customize')
    .setDescription(en['cmd.customize.desc'])
    .setDescriptionLocalization('tr', tr['cmd.customize.desc'])
    .addSubcommand((sub) =>
      sub.setName('view').setDescription(en['cmd.customize.view.desc']).addStringOption(platformOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('template')
        .setDescription(en['cmd.customize.template.desc'])
        .addStringOption(platformOption)
        .addStringOption(counterOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('format')
        .setDescription(en['cmd.customize.format.desc'])
        .addStringOption(platformOption)
        .addStringOption(counterOption)
        .addStringOption((option) =>
          option
            .setName('format')
            .setDescription(en['option.format'])
            .setDescriptionLocalization('tr', tr['option.format'])
            .addChoices(
              {
                name: en['choice.format.compact'],
                value: 'compact',
                name_localizations: { tr: tr['choice.format.compact'] },
              },
              {
                name: en['choice.format.full'],
                value: 'full',
                name_localizations: { tr: tr['choice.format.full'] },
              },
            )
            .setRequired(true),
        ),
    )
    .setContexts(InteractionContextType.Guild),
  descKey: 'cmd.customize.desc',
  cooldownSeconds: 30,
  requiredPerm: PermissionFlagsBits.ManageChannels,
  modals: [
    {
      prefix: 'customize:template:',
      perm: PermissionFlagsBits.ManageChannels,
      handle: handleTemplateModal,
    },
  ],
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand(true);
    const platform = interaction.options.getString('platform', true) as Platform;
    const label = ctx.t(`platform.${platform}`);
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: ctx.t('common.error'), flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'view') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelRow = await selectPanel(guildId, platform);
      if (!panelRow) {
        await interaction.editReply(ctx.t('panel.none', { platform: label }));
        return;
      }
      const counters = await selectCountersWithReasons([panelRow.id]);
      const defaults = DEFAULT_TEMPLATES[platform] as Partial<Record<string, string>>;
      const locale = interaction.guild?.preferredLocale ?? 'en';
      const stats = panelRow.lastStats
        ? { sourceName: panelRow.sourceName ?? '', values: panelRow.lastStats }
        : null;
      const embed = new EmbedBuilder()
        .setColor(panelRow.enabled ? 0x57f287 : 0xed4245)
        .setTitle(ctx.t('customize.viewTitle', { platform: label }))
        .setAuthor({ name: interaction.guild?.name ?? '', iconURL: interaction.guild?.iconURL() ?? undefined });
      for (const counter of counters) {
        const mark = counter.enabled ? '✅' : '⛔';
        const template = counter.template ?? defaults[counter.type] ?? '';
        const input = { type: counter.type, template: counter.template, numberFormat: counter.numberFormat };
        // The preview only exists once the scheduler stored real numbers for this panel.
        const preview = stats ? counterPreview(input, platform, stats, locale) : null;
        const lines = [`\`${mark}\` <#${counter.channelId}>`];
        lines.push(`${ctx.t('customize.templateLabel')}: \`${template}\``);
        if (preview !== null) {
          lines.push(`${ctx.t('customize.previewLabel')}: \`${preview}\``);
        }
        lines.push(`${ctx.t('customize.formatLabel')}: ${ctx.t(counter.numberFormat === 'compact' ? 'format.compact' : 'format.full')}`);
        if (counter.reason) {
          lines.push(`\`⚠️\` ${counter.reason}`);
        }
        embed.addFields({
          name: counterText(ctx.t, counter.type),
          value: lines.join('\n').slice(0, 1024),
          inline: counter.type !== 'category',
        });
      }
      embed.setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const counterType = interaction.options.getString('counter', true);
    const panelRow = await selectPanel(guildId, platform);
    if (!panelRow) {
      await interaction.reply({ content: ctx.t('panel.none', { platform: label }), flags: MessageFlags.Ephemeral });
      return;
    }
    const counters = await selectCountersWithReasons([panelRow.id]);
    const counter = counters.find((entry) => entry.type === counterType);
    if (!counter) {
      const valid = counters.map((entry) => counterText(ctx.t, entry.type)).join(', ');
      await interaction.reply({
        content: ctx.t('customize.counterWrongPlatform', {
          counter: counterText(ctx.t, counterType),
          platform: label,
          valid,
        }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'format' && counterType === 'category') {
      await interaction.reply({ content: ctx.t('customize.categoryNoFormat'), flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'template') {
      const defaults = DEFAULT_TEMPLATES[platform] as Partial<Record<string, string>>;
      const current = counter.template ?? defaults[counterType] ?? '';
      const placeholder = counterType === 'category' ? '[name]' : `[${counterType}]`;
      const modal = new ModalBuilder()
        .setCustomId(`customize:template:${counter.id}`)
        .setTitle(ctx.t('customize.modalTitle', { counter: counterText(ctx.t, counterType) }).slice(0, 45))
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(ctx.t('customize.modalLabel', { placeholder }).slice(0, 45))
            .setDescription(ctx.t('customize.modalDesc').slice(0, 100))
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId('template')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(100)
                .setValue(current),
            ),
        );
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const format = interaction.options.getString('format', true) as 'compact' | 'full';
    await setCounterFormat(counter.id, format);
    await interaction.editReply(
      ctx.t('customize.formatSaved', {
        counter: counterText(ctx.t, counterType),
        format: ctx.t(format === 'compact' ? 'format.compact' : 'format.full'),
      }),
    );
  },
};

async function handleTemplateModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    return;
  }
  const t = translator(resolveLocale(interaction.locale));
  const counterId = Number(interaction.customId.split(':')[2]);
  const row = Number.isInteger(counterId) ? await selectCounterById(counterId) : null;
  if (!row || row.guildId !== guildId) {
    await interaction.reply({ content: t('customize.counterMissing'), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const candidate = interaction.fields.getTextInputValue('template').trim();
  const type = row.type;
  if (candidate.length > 0) {
    if (type === 'category') {
      if (!candidate.includes('[name]')) {
        await interaction.editReply(t('customize.needPlaceholder', { placeholder: '[name]' }));
        return;
      }
      if (new RegExp(`\\[(${COUNTER_TYPES.join('|')})\\]`).test(candidate)) {
        await interaction.editReply(t('customize.categoryNoStats'));
        return;
      }
    } else if (!candidate.includes(`[${type}]`)) {
      await interaction.editReply(t('customize.needPlaceholder', { placeholder: `[${type}]` }));
      return;
    }
    // Render with a sample number first, the rendered name is longer than the template.
    const locale = guild.preferredLocale ?? 'en';
    const stats = {
      sourceName: 'Sample',
      values: (type === 'category' ? {} : { [type as StatKey]: 1234567890 }) as Partial<Record<StatKey, number>>,
    };
    const length = counterNameLength({ type, template: candidate, numberFormat: row.numberFormat }, row.platform, stats, locale);
    if (length > 100) {
      await interaction.editReply(t('customize.tooLong', { length }));
      return;
    }
    await setCounterTemplate(row.id, candidate);
    await interaction.editReply(t('customize.templateSaved', { counter: counterText(t, type) }));
    return;
  }
  // Empty submission resets to the platform default.
  await setCounterTemplate(row.id, null);
  await interaction.editReply(t('customize.templateReset', { counter: counterText(t, type) }));
}
