import * as SentryNode from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import type * as SentryModule from './sentry';
import { sanitizeSentryEvent } from './sentry';

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

  it('wires the shared sanitizer in as beforeSend so no event ever bypasses it', () => {
    process.env.SENTRY_DSN = 'https://example.ingest.sentry.io/1';
    const {
      Sentry,
      initSentry,
      sanitizeSentryEvent: sanitizer,
    } = loadSentryModule();

    initSentry();

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ beforeSend: sanitizer }),
    );
  });

  it('treats a blank SENTRY_DSN the same as unset', () => {
    process.env.SENTRY_DSN = '   ';
    const { Sentry, initSentry, isSentryInitialized } = loadSentryModule();

    initSentry();

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });
});

describe('sanitizeSentryEvent', () => {
  it('redacts request headers, cookies, and body before the event leaves the process', () => {
    const event = {
      request: {
        headers: {
          authorization: 'Bearer fake-session-token',
          cookie: 'session=fake-cookie-value',
        },
        cookies: { session: 'fake-cookie-value' },
        data: { password: 'fake-password', username: 'jane' },
      },
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event) as ErrorEvent & {
      request: {
        headers: Record<string, string>;
        cookies: string;
        data: Record<string, unknown>;
      };
    };

    expect(sanitized.request.headers.authorization).toBe('[REDACTED]');
    expect(sanitized.request.headers.cookie).toBe('[REDACTED]');
    // The whole "cookies" object is blanket-redacted since the key itself
    // is sensitive — a stricter guarantee than per-field nested redaction.
    expect(sanitized.request.cookies).toBe('[REDACTED]');
    expect(sanitized.request.data.password).toBe('[REDACTED]');
    expect(sanitized.request.data.username).toBe('jane');
  });

  it('redacts the user email but keeps a non-sensitive user id', () => {
    const event = {
      user: { id: 'user-123', email: 'fake-user@example.test' },
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event) as ErrorEvent & {
      user: { id: string; email: string };
    };

    expect(sanitized.user.email).toBe('[REDACTED]');
    expect(sanitized.user.id).toBe('user-123');
  });

  it('redacts sensitive keys inside extra and contexts', () => {
    const event = {
      extra: { apiToken: 'fake-extra-token', pagesAnalyzed: 12 },
      contexts: {
        audit: { organizationSecret: 'fake-secret', auditId: 'audit-1' },
      },
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event) as ErrorEvent & {
      extra: { apiToken: string; pagesAnalyzed: number };
      contexts: { audit: { organizationSecret: string; auditId: string } };
    };

    expect(sanitized.extra.apiToken).toBe('[REDACTED]');
    expect(sanitized.extra.pagesAnalyzed).toBe(12);
    expect(sanitized.contexts.audit.organizationSecret).toBe('[REDACTED]');
    expect(sanitized.contexts.audit.auditId).toBe('audit-1');
  });

  it('redacts secrets embedded in breadcrumb data and breadcrumb free-text messages', () => {
    const event = {
      breadcrumbs: [
        {
          message: 'Retrying request with token=fake-token-999 after 401',
          data: { authorization: 'Bearer fake-breadcrumb-token' },
        },
      ],
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event) as ErrorEvent & {
      breadcrumbs: Array<{ message: string; data: { authorization: string } }>;
    };

    expect(sanitized.breadcrumbs[0].message).not.toContain('fake-token-999');
    expect(sanitized.breadcrumbs[0].data.authorization).toBe('[REDACTED]');
  });

  it('scrubs a secret embedded in an exception message, not only structured fields', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value:
              'Upstream call failed for fake-user@example.test: api_key=fake-api-key-42',
          },
        ],
      },
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event) as ErrorEvent & {
      exception: { values: Array<{ value: string }> };
    };

    expect(sanitized.exception.values[0].value).not.toContain(
      'fake-user@example.test',
    );
    expect(sanitized.exception.values[0].value).not.toContain(
      'fake-api-key-42',
    );
  });

  it('scrubs a secret embedded in the top-level event message', () => {
    const event = {
      message: 'Failed with cookie=fake-cookie-abc still attached',
    } as unknown as ErrorEvent;

    const sanitized = sanitizeSentryEvent(event) as ErrorEvent & {
      message: string;
    };

    expect(sanitized.message).not.toContain('fake-cookie-abc');
  });

  it('never lets a real-shaped fixture value reach the event unredacted, structured or free-text alike', () => {
    const event = {
      request: {
        headers: { cookie: 'session=fake-cookie-xyz' },
      },
      user: { email: 'fake-user@example.test' },
      exception: {
        values: [
          { value: 'token=fake-token-abc rejected for fake-user@example.test' },
        ],
      },
    } as unknown as ErrorEvent;

    const serialized = JSON.stringify(sanitizeSentryEvent(event));

    expect(serialized).not.toContain('fake-cookie-xyz');
    expect(serialized).not.toContain('fake-user@example.test');
    expect(serialized).not.toContain('fake-token-abc');
  });
});
