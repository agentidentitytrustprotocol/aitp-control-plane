/**
 * Shutdown coordinator.
 *
 * On SIGTERM (Kubernetes pod termination) or SIGINT (Ctrl-C in dev) we
 * want to:
 *   1. Flip a "draining" flag so /api/readyz returns 503 — the LB
 *      removes us from rotation while we finish in-flight work.
 *   2. Stop the background timers (expiry, retention, webhook reaper,
 *      rate-limit GC). They're .unref()'d, but stopping them explicitly
 *      keeps tests deterministic and prevents a tick firing during
 *      shutdown.
 *   3. Wait up to GRACE_PERIOD_MS for the LB readiness probe to notice
 *      and stop sending traffic, then exit.
 *
 * We intentionally do NOT wait for in-flight HTTP requests to drain
 * here — Next.js owns the HTTP server and will respond to SIGTERM by
 * draining its own listener. Our job is to make /api/readyz lie first
 * so we don't accept *new* traffic during the drain window.
 */

import { logger } from './logger';

const GRACE_PERIOD_MS = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __shuttingDown: boolean | undefined;
  // eslint-disable-next-line no-var
  var __shutdownHooksRegistered: boolean | undefined;
}

export function isShuttingDown(): boolean {
  return globalThis.__shuttingDown === true;
}

function clearBackgroundTimers(): void {
  // Imports happen lazily — these modules register their own globals
  // and we only need to *cancel* them here, not pull in their full
  // surface area.
  const g = globalThis as {
    __expiryInterval?: ReturnType<typeof setInterval>;
    __retentionInterval?: ReturnType<typeof setInterval>;
    __webhookReaperInterval?: ReturnType<typeof setInterval>;
    __rateLimiterGcInterval?: ReturnType<typeof setInterval>;
  };
  if (g.__expiryInterval) {
    clearInterval(g.__expiryInterval);
    g.__expiryInterval = undefined;
  }
  if (g.__retentionInterval) {
    clearInterval(g.__retentionInterval);
    g.__retentionInterval = undefined;
  }
  if (g.__webhookReaperInterval) {
    clearInterval(g.__webhookReaperInterval);
    g.__webhookReaperInterval = undefined;
  }
  if (g.__rateLimiterGcInterval) {
    clearInterval(g.__rateLimiterGcInterval);
    g.__rateLimiterGcInterval = undefined;
  }
}

export type ExtraHook = () => Promise<void> | void;

/** Register process signal handlers. Idempotent. Extra hooks run AFTER
 * the readiness flip and BEFORE process.exit. */
export function registerShutdownHooks(extras: ExtraHook[] = []): void {
  if (globalThis.__shutdownHooksRegistered) return;
  globalThis.__shutdownHooksRegistered = true;

  const handle = (signal: NodeJS.Signals) => {
    if (globalThis.__shuttingDown) return;
    globalThis.__shuttingDown = true;
    logger.info({ signal }, 'shutdown: draining');

    clearBackgroundTimers();

    // Fire extra hooks in parallel — they're all best-effort. A failing
    // hook should not block the others.
    const hookPromises = extras.map((h) =>
      Promise.resolve()
        .then(h)
        .catch((err) => logger.warn({ err }, 'shutdown: hook failed')),
    );

    // Cap the whole shutdown window. If hooks hang, we'd rather exit
    // and let the orchestrator restart us than block forever.
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, GRACE_PERIOD_MS).unref?.(),
    );

    Promise.race([Promise.all(hookPromises).then(() => undefined), deadline])
      .catch(() => undefined)
      .finally(() => {
        logger.info('shutdown: exiting');
        process.exit(0);
      });
  };

  process.once('SIGTERM', handle);
  process.once('SIGINT', handle);
}
