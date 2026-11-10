import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../db/client.js';
import { config } from '../lib/config.js';
import { childLogger } from '../lib/logger.js';
import { startMetricsServer } from '../lib/metrics.js';
import { assertWebAuthConfig, completeLogin, startLogin } from './auth.js';

/** Public website and Discord OAuth login, the dashboard arrives with its own commit. */

const log = childLogger('web');
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.resolve('website', 'html'));
app.locals.siteUrl = config.SITE_URL;

app.set('trust proxy', resolveTrustProxy(config.TRUST_PROXY));

// CSP is same origin only, the Cloudflare Web Analytics beacon is the one external exception.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        scriptSrc: ["'self'", 'static.cloudflareinsights.com'],
        imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
        connectSrc: ["'self'", 'static.cloudflareinsights.com'],
      },
    },
    // COEP would break the avatar cdn, it sends no CORP headers.
    crossOriginEmbedderPolicy: false,
  }),
);

const staticDir = (dir: string) => path.resolve('website', dir);
app.use('/css', express.static(staticDir('css'), { index: false, maxAge: '1d' }));
app.use('/js', express.static(staticDir('js'), { index: false, maxAge: '1d' }));
app.use('/vendor', express.static(staticDir('vendor'), { index: false, maxAge: '1d' }));
app.use('/img', express.static(staticDir('img'), { index: false, maxAge: '7d' }));

assertWebAuthConfig();
const sessionStore = new (connectPgSimple(session))({ pool, tableName: 'session' });
app.use(session({
  store: sessionStore,
  secret: config.SESSION_SECRET ?? '',
  resave: false,
  saveUninitialized: false,
  // Visits slide the expiry forward, inactive sessions still die after a week.
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user ?? null;
  next();
});

app.get('/', (_req, res) => {
  res.render('home', { active: 'home' });
});

const pages: Array<[route: string, active: string]> = [
  ['/commands', 'commands'],
  ['/guide', 'guide'],
  ['/faqs', 'faqs'],
  ['/about', 'about'],
  ['/privacy', ''],
  ['/tos', ''],
];
for (const [route, active] of pages) {
  app.get(route, (req, res) => {
    if (route === '/guide') {
      const requested = String(req.query.platform ?? '');
      const supported = requested === 'youtube' || requested === 'twitch' || requested === 'kick';
      res.render('guide', { active, platformId: supported ? requested : 'youtube' });
      return;
    }
    res.render(route.slice(1), { active });
  });
}

app.get('/sitemap.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/xml').render('sitemap', {
    urls: ['/', ...pages.map(([route]) => route)],
  });
});

app.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('text/plain').render('robots');
});

const INVITE_PERMISSIONS = '275146729488';
app.get('/add', (_req, res) => {
  if (!config.DISCORD_CLIENT_ID) {
    res.status(503).json({ error: 'client id not configured' });
    return;
  }
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    permissions: INVITE_PERMISSIONS,
    scope: 'applications.commands bot',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many attempts, try again later.',
});

app.get('/login', loginLimiter, (req, res) => {
  if (req.session.user) {
    res.redirect('/');
    return;
  }
  res.redirect(startLogin(req.session));
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.redirect('/');
    return;
  }
  try {
    await completeLogin(req, code, state);
    res.redirect('/');
  } catch (err) {
    log.warn({ err }, 'login failed');
    res.redirect('/');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

app.use((_req, res) => {
  res.status(404).render('404');
});

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  log.error({ err }, 'unhandled web error');
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).send('Something went wrong!');
});

const server = app.listen(config.WEB_PORT, () => {
  log.info({ port: config.WEB_PORT }, 'web listening');
});

let metricsServer: http.Server | undefined;
if (config.METRICS_ENABLED) {
  metricsServer = startMetricsServer(config.METRICS_PORT);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    void sessionStore.close();
    server.close(() => process.exit(0));
    metricsServer?.close(() => process.exit(0));
    // Fallback if sockets refuse to drain.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

function resolveTrustProxy(value: string | undefined): number | string {
  if (value === undefined) {
    return 'loopback';
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}
