import { db } from './client.js';
import { guilds } from './schema.js';

/** Guild queries. */

// Insert if missing, ignore if present.
export async function ensureGuild(id: string): Promise<void> {
  await db.insert(guilds).values({ id }).onConflictDoNothing();
}
