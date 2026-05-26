import pino, { type Logger } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;
const level = process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug');

function buildLogger(): Logger {
  if (isTest) {
    // Tests: silent by default. Enable with LOG_LEVEL=debug to debug a failure.
    return pino({ level: process.env.LOG_LEVEL ?? 'silent' });
  }
  if (isProduction) {
    return pino({
      level,
      base: { service: 'aitp-control-plane' },
      formatters: { level: (label) => ({ level: label }) },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return pino({
    level,
    base: { service: 'aitp-control-plane' },
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    },
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __logger: Logger | undefined;
}

export const logger: Logger = globalThis.__logger ?? (globalThis.__logger = buildLogger());

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
