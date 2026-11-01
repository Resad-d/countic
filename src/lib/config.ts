import { z } from 'zod';

/** Central, zod-validated configuration. */

const boolish = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const emptyToUndefined = (value: unknown): unknown => value === '' ? undefined : value;

const optionalEnvString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalEnvInt = (schema: z.ZodType<number>) => z.preprocess(emptyToUndefined, schema).optional();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.url().default('postgres://countic:countic@localhost:5432/countic'),

  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  METRICS_ENABLED: boolish,
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9101),
  BOT_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9102),

  DISCORD_TOKEN: optionalEnvString,
  DISCORD_CLIENT_ID: optionalEnvString,
  DISCORD_CLIENT_SECRET: optionalEnvString,
  DISCORD_ADMIN_GUILD_ID: optionalEnvString,
  DISCORD_OWNER_ID: optionalEnvString,

  YOUTUBE_API_KEY: optionalEnvString,
  TWITCH_CLIENT_ID: optionalEnvString,
  TWITCH_CLIENT_SECRET: optionalEnvString,
  KICK_CLIENT_ID: optionalEnvString,
  KICK_CLIENT_SECRET: optionalEnvString,

  // Cadence floors are 10 minutes because Discord allows 2 channel renames per 10 minutes.
  YOUTUBE_REFRESH_CADENCE_MINUTES: optionalEnvInt(z.coerce.number().int().min(10)).default(60),
  TWITCH_REFRESH_CADENCE_MINUTES: optionalEnvInt(z.coerce.number().int().min(10)).default(15),
  KICK_REFRESH_CADENCE_MINUTES: optionalEnvInt(z.coerce.number().int().min(10)).default(15),
  SCHEDULER_TICK_SECONDS: optionalEnvInt(z.coerce.number().int().min(10)).default(60),
  SCHEDULER_MAX_PANELS_PER_TICK: optionalEnvInt(z.coerce.number().int().min(1)).default(200),

  YOUTUBE_QUOTA_BUDGET: optionalEnvInt(z.coerce.number().int().min(1)).default(8000),
  YOUTUBE_REFRESH_POOL: optionalEnvInt(z.coerce.number().int().min(1)).default(7000),
  YOUTUBE_RESOLUTION_RESERVE: optionalEnvInt(z.coerce.number().int().min(1)).default(1000),
  RESOLUTION_DAILY_PER_GUILD: optionalEnvInt(z.coerce.number().int().min(1)).default(50),
  COMMAND_LOG_RETENTION_DAYS: optionalEnvInt(z.coerce.number().int().min(1)).default(90),
});

type Config = z.infer<typeof configSchema>;

function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration. ${details}`);
  }
  const value = result.data;
  if (value.YOUTUBE_REFRESH_POOL + value.YOUTUBE_RESOLUTION_RESERVE > value.YOUTUBE_QUOTA_BUDGET) {
    throw new Error('Invalid configuration. Quota pools exceed YOUTUBE_QUOTA_BUDGET.');
  }
  return value;
}

export const config = loadConfig();
