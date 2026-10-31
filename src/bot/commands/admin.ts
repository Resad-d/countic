import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  Status,
  type ChatInputCommandInteraction,
  type Client,
  version as djsVersion,
} from 'discord.js';
import { adminSql, selectAdminStats, type AdminSqlResult } from '../../db/queries.js';
import { config } from '../../lib/config.js';
import { en } from '../../lib/i18n/index.js';
import { childLogger } from '../../lib/logger.js';
import { quotaSnapshot } from '../../lib/quota.js';
import type { CommandContext, CommandDef } from './index.js';

/** Owner only diagnostics. */

const log = childLogger('admin');

const COLOR = 0x5865f2;

const STATUS_NAME: Record<number, string> = {
  [Status.Ready]: 'READY',
  [Status.Connecting]: 'CONNECTING',
  [Status.Reconnecting]: 'RECONNECTING',
  [Status.Idle]: 'IDLE',
  [Status.Nearly]: 'NEARLY',
  [Status.Disconnected]: 'DISCONNECTED',
  [Status.WaitingForGuilds]: 'WAITING_FOR_GUILDS',
  [Status.Identifying]: 'IDENTIFYING',
  [Status.Resuming]: 'RESUMING',
};

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function trunc(text: string, max = 3900): string {
  return text.length > max ? `${text.slice(0, max)}... (truncated)` : text;
}

type ShardSnapshot = {
  ids: string;
  status: number;
  ping: number;
  guilds: number;
  rss: number;
  uptime: number;
};

// One snapshot per shard, or a single local snapshot when sharding is off.
async function shardSnapshots(client: Client): Promise<ShardSnapshot[]> {
  if (!client.shard) {
    return [
      {
        ids: '0',
        status: client.ws.status,
        ping: Number.isFinite(client.ws.ping) ? client.ws.ping : -1,
        guilds: client.guilds.cache.size,
        rss: process.memoryUsage().rss,
        uptime: process.uptime(),
      },
    ];
  }
  return client.shard.broadcastEval<ShardSnapshot>((c) => ({
    ids: c.shard?.ids.join(',') ?? '0',
    status: c.ws.status,
    ping: Number.isFinite(c.ws.ping) ? c.ws.ping : -1,
    guilds: c.guilds.cache.size,
    rss: process.memoryUsage().rss,
    uptime: process.uptime(),
  }));
}

async function runStats(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [shards, stats, quota] = await Promise.all([
    shardSnapshots(interaction.client),
    selectAdminStats(),
    quotaSnapshot(),
  ]);
  const ready = shards.filter((s) => s.status === Status.Ready).length;
  const totalGuilds = shards.reduce((total, s) => total + s.guilds, 0);
  const totalRss = shards.reduce((total, s) => total + s.rss, 0);
  const pings = shards.map((s) => s.ping).filter((ping) => ping >= 0);
  const avgPing = pings.length ? Math.round(pings.reduce((total, ping) => total + ping, 0) / pings.length) : -1;
  const oldest = Math.max(...shards.map((s) => s.uptime));
  const counterTotal = stats.counters.reduce((total, c) => total + c.total, 0);
  const counterOn = stats.counters.reduce((total, c) => total + c.enabled, 0);
  const uses = stats.usage.reduce((total, u) => total + u.uses, 0);
  const failed = stats.usage.reduce((total, u) => total + u.failed, 0);
  const panels = stats.panels.map((p) => `${en[`platform.${p.platform}`]} ${p.total} (${p.enabled} on)`).join(' • ');
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Bot statistics')
    .addFields(
      { name: 'Guilds', value: `${totalGuilds} (cached)`, inline: true },
      { name: 'Shards', value: `${ready}/${shards.length} ready`, inline: true },
      { name: 'Avg ping', value: avgPing < 0 ? '?' : `${avgPing}ms`, inline: true },
      { name: 'RAM', value: `${mb(totalRss)} MB`, inline: true },
      { name: 'Uptime (oldest shard)', value: fmtDuration(oldest), inline: true },
      { name: 'Versions', value: `Node ${process.version} • discord.js ${djsVersion}`, inline: true },
      { name: 'Panels configured', value: panels || 'none', inline: true },
      { name: 'DB guilds', value: String(stats.guilds), inline: true },
      { name: 'Counters', value: `${counterTotal} (${counterOn} on)`, inline: true },
      {
        name: 'Quota today',
        value: `refresh ${quota.refresh}/${config.YOUTUBE_REFRESH_POOL} • res ${quota.resolution}/${config.YOUTUBE_RESOLUTION_RESERVE}`,
        inline: true,
      },
      { name: 'Commands 24h', value: `${uses} (${failed} failed)`, inline: true },
    );
  await interaction.editReply({ embeds: [embed] });
}

async function runShards(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const shards = await shardSnapshots(interaction.client);
  const ready = shards.filter((s) => s.status === Status.Ready).length;
  const lines = shards
    .sort((a, b) => a.ids.localeCompare(b.ids, undefined, { numeric: true }))
    .map(
      (s) =>
        `S${s.ids} ${STATUS_NAME[s.status] ?? '?'}  ping ${s.ping < 0 ? '?' : `${s.ping}ms`}  guilds ${s.guilds}  RAM ${mb(s.rss)} MB  up ${fmtDuration(s.uptime)}`,
    );
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Shards')
    .setDescription(trunc(lines.join('\n')))
    .addFields({
      name: 'Totals',
      value: `${ready}/${shards.length} ready  •  ${shards.reduce((total, s) => total + s.guilds, 0)} guilds  •  RAM ${mb(shards.reduce((total, s) => total + s.rss, 0))} MB`,
    });
  await interaction.editReply({ embeds: [embed] });
}

async function runRespawn(interaction: ChatInputCommandInteraction): Promise<void> {
  const client = interaction.client;
  if (!client.shard) {
    await interaction.reply({ content: 'Not sharded, nothing to respawn.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content: `Respawning all ${client.shard.count} shards, this shard goes down too.`,
    flags: MessageFlags.Ephemeral,
  });
  await client.shard.respawnAll();
}

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/`/g, "'").replace(/\s+/g, ' ');
}

function formatSqlResult(result: AdminSqlResult): string {
  const lines: string[] = [`${result.rowCount} rows`, result.fields.join(' | ')];
  let length = lines[0].length + lines[1].length;
  for (const [index, row] of result.rows.entries()) {
    const line = result.fields.map((field) => cell(row[field])).join(' | ');
    if (index >= 500 || length + line.length > 1600) {
      lines.push(`showing ${index} of ${result.rowCount} rows, output truncated`);
      break;
    }
    lines.push(line);
    length += line.length;
  }
  return ['```', ...lines, '```'].join('\n');
}

async function runSql(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const query = interaction.options.getString('query', true).trim();
  if (query.includes(';')) {
    await interaction.editReply({ content: 'Single statement only, remove the semicolon.' });
    return;
  }
  ctx.auditDetail = query.length > 400 ? `${query.slice(0, 400)}...` : query;
  try {
    const result = await adminSql(query);
    await interaction.editReply({ content: formatSqlResult(result) });
  } catch (err) {
    ctx.auditOk = false;
    ctx.auditDetail = `error: ${query.slice(0, 400)}`;
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'admin sql query failed');
    await interaction.editReply({ content: `Query failed: ${message.slice(0, 500)}` });
  }
}

export const admin: CommandDef = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription(en['cmd.admin.desc'])
    .addSubcommand((sub) => sub.setName('stats').setDescription('Guild, panel, counter, quota and usage totals.'))
    .addSubcommand((sub) => sub.setName('shards').setDescription('Per shard state, ping, guilds, memory and uptime.'))
    .addSubcommand((sub) => sub.setName('respawn').setDescription('Restart every shard.'))
    .addSubcommand((sub) =>
      sub
        .setName('sql')
        .setDescription('Run one read only SQL query.')
        .addStringOption((option) =>
          option.setName('query').setDescription('Single SQL statement, no semicolon.').setRequired(true),
        ),
    )
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 0,
  requiredPerm: null,
  descKey: 'cmd.admin.desc',
  ownerOnly: true,
  async execute(interaction, ctx) {
    switch (interaction.options.getSubcommand(true)) {
      case 'stats':
        await runStats(interaction);
        break;
      case 'shards':
        await runShards(interaction);
        break;
      case 'respawn':
        await runRespawn(interaction);
        break;
      case 'sql':
        await runSql(interaction, ctx);
        break;
    }
  },
};
