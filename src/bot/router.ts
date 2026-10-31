import {
  Events,
  MessageFlags,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { insertCommandUsage } from '../db/queries.js';
import { config } from '../lib/config.js';
import { resolveLocale, translator } from '../lib/i18n/index.js';
import { childLogger } from '../lib/logger.js';
import { buttonHandlers, modalHandlers, userCommands, type Perm, type Providers } from './commands/index.js';
import { storeCommandIds } from './commands/help.js';

/** Interaction routing, command registration, per guild cooldowns and auditing. */

const log = childLogger('commands');

/** One-shot global slash command registration on startup. */
async function registerCommands(): Promise<void> {
  const token = config.DISCORD_TOKEN;
  if (!config.DISCORD_CLIENT_ID || !token) {
    log.warn('DISCORD_CLIENT_ID missing, command registration skipped');
    return;
  }
  const body = userCommands.map((command) => command.data.toJSON());
  const rest = new REST().setToken(token);
  const created = (await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body })) as {
    id: string;
    name: string;
  }[];
  storeCommandIds(created);
  log.info({ count: body.length }, 'global commands registered');
}

// Guild plus command name to expiry timestamp, pruned lazily so the map stays bounded.
const cooldowns = new Map<string, number>();

function consumeCooldown(key: string, seconds: number): number {
  if (seconds <= 0) {
    return 0;
  }
  const now = Date.now();
  if (cooldowns.size > 1000) {
    for (const [entryKey, expiry] of cooldowns) {
      if (expiry <= now) {
        cooldowns.delete(entryKey);
      }
    }
  }
  const expiry = cooldowns.get(key) ?? 0;
  if (now < expiry) {
    return Math.ceil((expiry - now) / 1000);
  }
  cooldowns.set(key, now + seconds * 1000);
  return 0;
}

export function wireCommands(client: Client, providers: Providers): void {
  client.once(Events.ClientReady, () => {
    // Registration runs once on shard 0, or on the single process when sharding is off.
    if (!client.shard || client.shard.ids.includes(0)) {
      registerCommands().catch((err) => {
        log.error({ err }, 'command registration failed');
      });
    }
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(interaction, client, providers);
  });
}

async function routeInteraction(interaction: Interaction, client: Client, providers: Providers): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction, client, providers);
    } else if (interaction.isButton() || interaction.isModalSubmit()) {
      await handleComponent(interaction);
    }
  } catch (err) {
    log.error({ err, id: interaction.id }, 'interaction handling failed');
    if (interaction.isButton() || interaction.isModalSubmit()) {
      await failComponent(interaction);
    }
  }
}

async function failComponent(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
  const t = translator(resolveLocale(interaction.locale));
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: t('common.error'), components: [] });
    } else if (interaction.isButton()) {
      await interaction.update({ content: t('common.error'), components: [] });
    } else {
      await interaction.reply({ content: t('common.error'), flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    log.warn({ err: replyErr }, 'component error reply failed');
  }
}

async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  providers: Providers,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    return;
  }
  const command = userCommands.find((def) => def.data.name === interaction.commandName);
  if (!command) {
    return;
  }
  const locale = resolveLocale(interaction.locale);
  const t = translator(locale);
  const sub = interaction.options.getSubcommand(false) ?? undefined;
  let ok = true;
  const started = Date.now();
  try {
    if (command.requiredPerm && !interaction.memberPermissions?.has(command.requiredPerm)) {
      ok = false;
      await interaction.reply({ content: t('common.noPermission'), flags: MessageFlags.Ephemeral });
    } else {
      const remaining = consumeCooldown(`${interaction.guildId}:${command.data.name}`, command.cooldownSeconds);
      if (remaining > 0) {
        ok = false;
        const time = Math.floor((Date.now() + remaining * 1000) / 1000);
        await interaction.reply({ content: t('common.cooldown', { time }), flags: MessageFlags.Ephemeral });
      } else {
        await command.execute(interaction, { client, providers, commands: userCommands, locale, t });
      }
    }
  } catch (err) {
    ok = false;
    log.error({ err, cmd: command.data.name, guildId: interaction.guildId }, 'command failed');
    const text = t('common.error');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: text }).catch(() => {});
    } else {
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  } finally {
    const ms = Date.now() - started;
    log.info(
      { evt: 'command', cmd: command.data.name, sub, guildId: interaction.guildId, userId: interaction.user.id, ms, ok },
      'command used',
    );
    try {
      await insertCommandUsage({
        command: command.data.name,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        ok,
        detail: sub,
      });
    } catch (err) {
      log.error({ err }, 'command usage insert failed');
    }
  }
}

// Buttons and modals are matched by customId prefix, each command file owns its handlers.
async function handleComponent(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    return;
  }
  if (interaction.isButton()) {
    const handler = buttonHandlers.find((entry) => interaction.customId.startsWith(entry.prefix));
    if (handler && (await componentPermOk(interaction, handler.perm))) {
      await handler.handle(interaction);
    }
    return;
  }
  const handler = modalHandlers.find((entry) => interaction.customId.startsWith(entry.prefix));
  if (handler && (await componentPermOk(interaction, handler.perm))) {
    await handler.handle(interaction);
  }
}

async function componentPermOk(interaction: ButtonInteraction | ModalSubmitInteraction, perm: Perm): Promise<boolean> {
  if (!perm || interaction.memberPermissions?.has(perm)) {
    return true;
  }
  const t = translator(resolveLocale(interaction.locale));
  await interaction.reply({ content: t('common.noPermission'), flags: MessageFlags.Ephemeral });
  return false;
}
