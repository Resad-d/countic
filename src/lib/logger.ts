import pino from 'pino';
import { config } from './config.js';

/** Shared pino logger. */

const root = pino({
  level: config.LOG_LEVEL,
  base: { env: config.NODE_ENV },
  redact: {
    paths: [
      'token',
      '*.token',
      'authorization',
      '*.authorization',
      'password',
      '*.password',
      'client_secret',
      '*.client_secret',
    ],
    censor: '[redacted]',
  },
});

export function childLogger(service: string): pino.Logger {
  return root.child({ service });
}
