import * as SentryNode from '@sentry/node';
import type * as SentryModule from './sentry';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
}));

/**
 * Loaded fresh inside each test (after jest.resetModules()) so every test
 * gets its own copy of both the @sentry/node mock and sentry.ts's
 * module-level `initialized` flag. A plain top-level import would keep
 * reusing the first run's mock instance even after resetModules() swaps in
 * a new one for the freshly-required './sentry' — and ts-jest's CommonJS
 * setup here has no --experimental-vm-modules, so a dynamic import() (the
 * usual alternative) isn't available either.
 */
function loadSentryModule(): {
  Sentry: typeof SentryNode;
} & typeof SentryModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sentry = require('@sentry/node') as typeof SentryNode;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sentry = require('./sentry') as typeof SentryModule;
  return { Sentry, ...sentry };
}

describe('sentry helpers', () => {
  const originalDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
    jest.clearAllMocks();
  });

  it('stays inert and never calls Sentry.init when SENTRY_DSN is unset', () => {
    delete process.env.SENTRY_DSN;
    const { Sentry, initSentry, isSentryInitialized, captureException } =
      loadSentryModule();

    initSentry();

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);

    expect(() => captureException(new Error('boom'))).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('initializes Sentry and forwards exceptions when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://example.ingest.sentry.io/1';
    const { Sentry, initSentry, isSentryInitialized, captureException } =
      loadSentryModule();

    initSentry();

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://example.ingest.sentry.io/1' }),
    );
    expect(isSentryInitialized()).toBe(true);

    const error = new Error('boom');
    captureException(error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('treats a blank SENTRY_DSN the same as unset', () => {
    process.env.SENTRY_DSN = '   ';
    const { Sentry, initSentry, isSentryInitialized } = loadSentryModule();

    initSentry();

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });
});
