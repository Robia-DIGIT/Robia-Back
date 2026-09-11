import * as Sentry from '@sentry/node';

let initialized = false;

/**
 * Optional, like GOOGLE_PAGESPEED_API_KEY (RC-10): SENTRY_DSN unset
 * means Sentry stays inert and this is a no-op, not a startup failure.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Error capture only in this slice - performance tracing and its
    // sampling rate are a separate decision (see the RC-15 handoff),
    // not something to enable by default alongside error reporting.
    tracesSampleRate: 0,
  });
  initialized = true;
}

export function isSentryInitialized(): boolean {
  return initialized;
}

/**
 * Only ever called for genuinely unexpected/5xx failures (see
 * AllExceptionsFilter) - never for ordinary 4xx HttpExceptions, which
 * are expected client-facing outcomes, not incidents.
 */
export function captureException(exception: unknown): void {
  if (!initialized) {
    return;
  }
  Sentry.captureException(exception);
}
