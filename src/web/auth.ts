import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { SessionData } from 'express-session';
import { config } from '../lib/config.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/users/@me';
const GUILDS_URL = 'https://discord.com/api/users/@me/guilds';

// Match the privacy policy.
const SCOPES = 'identify guilds';

interface LoginChallenge {
  state: string;
  verifier: string;
}

interface DiscordProfile {
  id: string;
  username: string;
  avatar: string | null;
}

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  features?: unknown;
}

export interface GuildStub {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export interface SessionUser {
  id: string;
  username: string;
  avatarUrl: string;
  guilds: GuildStub[];
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    login?: LoginChallenge;
    loginReturn?: string;
  }
}

export function assertWebAuthConfig(): void {
  const missing = (
    [
      ['DISCORD_CLIENT_ID', config.DISCORD_CLIENT_ID],
      ['DISCORD_CLIENT_SECRET', config.DISCORD_CLIENT_SECRET],
      ['SESSION_SECRET', config.SESSION_SECRET],
    ] as const
  ).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing configuration for web login: ${missing.join(', ')}`);
  }
}

export function startLogin(session: SessionData): string {
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  session.login = { state, verifier };

  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID ?? '',
    redirect_uri: `${config.SITE_URL}/callback`,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function completeLogin(req: Request, code: string, state: string): Promise<void> {
  const login = req.session.login;
  // Consumed before any await, a replayed callback can never reuse the pair.
  delete req.session.login;
  if (!login || !sameHex(login.state, state)) {
    throw new Error('state mismatch');
  }

  const user = await fetchDiscordIdentity(code, login.verifier);

  // A fresh sid means a stolen pre-login cookie cannot become a logged-in one.
  await regenerate(req);
  req.session.user = user;
}

function sameHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * Exchanges the code and builds the session user.
 * Tokens die with this function, only the identity survives.
 */
async function fetchDiscordIdentity(code: string, verifier: string): Promise<SessionUser> {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID ?? '',
      client_secret: config.DISCORD_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.SITE_URL}/callback`,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`token exchange failed with ${tokenResponse.status} ${body.slice(0, 200)}`);
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

  const [profile, guilds] = await Promise.all([
    fetchJson<DiscordProfile>(USER_URL, accessToken),
    fetchJson<DiscordGuild[]>(`${GUILDS_URL}?limit=200`, accessToken),
  ]);

  return {
    id: profile.id,
    username: profile.username,
    avatarUrl: avatarUrl(profile.id, profile.avatar),
    guilds: guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner,
      permissions: guild.permissions,
    })),
  };
}

async function fetchJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`request to ${url} failed with ${response.status} ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

function avatarUrl(id: string, avatar: string | null): string {
  if (!avatar) {
    // Discord derives the default avatar from the id.
    const index = (BigInt(id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png?size=64`;
  }
  const extension = avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${extension}?size=64`;
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (!error) {
        resolve();
        return;
      }
      reject(error instanceof Error ? error : new Error('session regenerate failed'));
    });
  });
}
