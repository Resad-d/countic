import { z } from 'zod';

/** Central, zod-validated configuration. */

const boolish = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const emptyToUndefined = (value: unknown): unknown => value === '' ? undefined : value;

const optionalEnvString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.url().default('postgres://countic:countic@localhost:5432/countic'),

  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  METRICS_ENABLED: boolish,
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9101),

  DISCORD_TOKEN: optionalEnvString,
  DISCORD_CLIENT_ID: optionalEnvString,
  DISCORD_CLIENT_SECRET: optionalEnvString,
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
  return result.data;
}

export const config = loadConfig();
