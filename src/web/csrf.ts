import crypto from 'node:crypto';
import type { Request } from 'express';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}

export function ensureCsrf(req: Request): string {
  req.session.csrf ??= crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

export function csrfOk(req: Request): boolean {
  const expected = req.session.csrf;
  const body = req.body as { _csrf?: unknown } | undefined;
  const provided = typeof body?._csrf === 'string' ? body._csrf : '';
  if (!expected || provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
