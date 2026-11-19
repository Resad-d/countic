# Countic

Live YouTube, Twitch and Kick statistics rendered as Discord voice channel names.

<p align="center">
  <img src="website/img/hero-loop.gif" width="378" alt="Counter channels updating live in Discord">
</p>

Point Countic at a creator and it keeps a set of voice channel names up to date with their live numbers, on YouTube, Twitch and Kick. Manage everything from the web dashboard or slash commands, with custom templates and number formats.

## Requirements

- Docker with the compose plugin, or Node 24 with a Postgres database
- A Discord application with its bot token, see [Discord application](#discord-application)
- At least one platform API key, see [API keys](#api-keys)

## Setup with Docker

1. Clone and enter the repository

   ```sh
   git clone https://github.com/Resad-d/countic.git
   cd countic
   ```

2. Create your environment file and fill it in, every value is explained in the [configuration](#configuration) section

   ```sh
   cp .env.example .env
   ```

3. Start the stack, migrations run automatically before the services boot

   ```sh
   docker compose up -d
   ```

4. Invite the bot using the [URL generator](#discord-application)
5. Create your first panel: run `/setup` in your server, or use the dashboard at `http://localhost:3000`

The dashboard is optional. Skip the web credentials and start only the bot and its database, compose pulls in Postgres and migrations automatically:

```sh
docker compose up -d bot
```

## Setup with Node

Requires Node 24 and a reachable Postgres.

1. `npm ci`
2. `cp .env.example .env` and point `DATABASE_URL` at your Postgres
3. `npx drizzle-kit push` to create the schema
4. `npm run build && npm run start:bot` for the bot, add `npm run start:web` for the web side

## Discord application

1. Create an application at the [Discord developer portal](https://discord.com/developers/applications)
2. Bot page: reset the token and put it in `DISCORD_TOKEN`
3. Invite the bot with the OAuth2 URL Generator: scopes `bot` and `applications.commands`, permissions **Manage Channels** and **View Channels**
4. Web only: OAuth2 page, copy the client id and secret into `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`
5. Web only: OAuth2 redirects, add `<SITE_URL>/callback`, for example `http://localhost:3000/callback`

## API keys

Credentials come from each platform's developer portal:

- YouTube: enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) in the Google Cloud console and create an API key
- Twitch: register an application in the [Twitch developer console](https://dev.twitch.tv/console/apps) for the client id and secret
- Kick: create an application in the [Kick developer portal](https://dev.kick.com) for the client id and secret

`SESSION_SECRET` and `TRANSPORT_SECRET` are random strings, generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Configuration

All values are optional except where noted. Everything is validated at startup, invalid config refuses to boot.

### Bot

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Required. Bot token from the developer portal |
| `YOUTUBE_API_KEY` | YouTube Data API key, required for YouTube panels |
| `TWITCH_CLIENT_ID` | Twitch app client id and secret, required for Twitch panels |
| `TWITCH_CLIENT_SECRET` | |
| `KICK_CLIENT_ID` | Kick app client id and secret, required for Kick panels |
| `KICK_CLIENT_SECRET` | |
| `COUNTIC_PG_PASSWORD` | Postgres password, change it from the default |

A platform without credentials boots fine, its panels and dashboard tab report unavailability.

### Web, only when running the dashboard

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | | OAuth2 client id |
| `DISCORD_CLIENT_SECRET` | | OAuth2 client secret |
| `SESSION_SECRET` | | Signs login sessions, at least 32 chars |
| `TRANSPORT_SECRET` | | Shared secret for the bot internal transport, at least 32 chars |
| `WEB_PORT` | `3000` | Port the web process listens on, compose publishes it |
| `SITE_URL` | `https://countic.app` | Public origin, used in OAuth redirects |
| `TRUST_PROXY` | unset | How many reverse proxies sit between visitors and Express. Express reads the visitor IP and the HTTPS state from that many hops back, which drives `Secure` cookies and per-IP rate limiting |

### Advanced

<details>
<summary>Sharding, database, scheduler and metrics variables</summary>

#### Sharding

| Variable | Default | Description |
| --- | --- | --- |
| `SHARD_COUNT` | unset | `unset` = single process, `auto` = Discord's recommended count (recommended in production), or a fixed number up to 64. Discord requires sharding beyond 2,500 servers, `auto` fetches the count on every boot |

#### Database and runtime

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://countic:countic@localhost:5432/countic` | Only read outside Docker, compose builds its own URL from `COUNTIC_PG_PASSWORD` |
| `NODE_ENV` | `development` | Label on every log line, `production` also enables the web template cache |
| `LOG_LEVEL` | `info` | `fatal` to `trace`, pino levels |

#### Scheduler and quota

YouTube costs are daily quota units, the API grants 10,000 per day. Refresh cadences floor at 10 minutes because Discord allows two renames per channel per 10 minutes. One refresh cycle costs a single unit per 50 panels, so the default budget supports thousands of YouTube panels.

| Variable | Default | Description |
| --- | --- | --- |
| `YOUTUBE_REFRESH_CADENCE_MINUTES` | `60` | How often YouTube counters refresh |
| `TWITCH_REFRESH_CADENCE_MINUTES` | `15` | Twitch refresh cadence |
| `KICK_REFRESH_CADENCE_MINUTES` | `15` | Kick refresh cadence |
| `SCHEDULER_TICK_SECONDS` | `60` | Scheduler tick length |
| `SCHEDULER_MAX_PANELS_PER_TICK` | `200` | Panel batches per tick |
| `YOUTUBE_QUOTA_BUDGET` | `8000` | Daily YouTube budget, pool plus reserve |
| `YOUTUBE_REFRESH_POOL` | `7000` | Units reserved for scheduled refreshes |
| `YOUTUBE_RESOLUTION_RESERVE` | `1000` | Units reserved for new source lookups |
| `RESOLUTION_DAILY_PER_GUILD` | `50` | New source lookups per guild per day |
| `COMMAND_LOG_RETENTION_DAYS` | `90` | Command usage log retention |

#### Metrics and admin

| Variable | Default | Description |
| --- | --- | --- |
| `METRICS_ENABLED` | `true` | Enables the Prometheus endpoints |
| `METRICS_PORT` | `9101` | Web metrics port |
| `BOT_METRICS_PORT` | `9102` | Bot metrics port, served by shard 0 |
| `DISCORD_ADMIN_GUILD_ID` | unset | Server id that hosts the admin pages |
| `DISCORD_OWNER_ID` | unset | Your user id, gates the `/admin` command |

</details>

## License

[Apache-2.0](LICENSE)

## Support

[Discord support server](https://discord.gg/kKRnpfR) or open an issue.
