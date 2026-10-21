import { defineConfig } from 'drizzle-kit';

// Config for the drizzle-kit CLI, not part of the app build.
// generate works offline. migrate and studio need a live database.
// The fallback URL matches the compose credentials for host runs.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://countic:countic@localhost:5432/countic',
  },
  strict: true,
  verbose: true,
});
