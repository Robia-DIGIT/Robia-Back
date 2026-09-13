import { redactSensitive, scrubText } from './redact';

describe('redactSensitive', () => {
  it('redacts a top-level sensitive key', () => {
    const result = redactSensitive({ password: 'hunter2', ok: true }) as Record<
      string,
      unknown
    >;

    expect(result.password).toBe('[REDACTED]');
    expect(result.ok).toBe(true);
  });

  it('redacts sensitive keys nested at any depth', () => {
    const result = redactSensitive({
      user: {
        profile: {
          email: 'someone@example.com',
        },
      },
      headers: {
        authorization: 'Bearer super-secret-jwt',
        cookie: 'session=abc123',
      },
    }) as {
      user: { profile: { email: string } };
      headers: { authorization: string; cookie: string };
    };

    expect(result.user.profile.email).toBe('[REDACTED]');
    expect(result.headers.authorization).toBe('[REDACTED]');
    expect(result.headers.cookie).toBe('[REDACTED]');
  });

  it('redacts common secret/token/key naming variants', () => {
    const result = redactSensitive({
      apiKey: 'a',
      api_key: 'b',
      GOOGLE_PAGESPEED_API_KEY: 'c',
      jwtSecret: 'd',
      accessToken: 'e',
      passwd: 'f',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('redacts inside arrays', () => {
    const result = redactSensitive({
      users: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    }) as { users: Array<{ email: string }> };

    expect(result.users[0].email).toBe('[REDACTED]');
    expect(result.users[1].email).toBe('[REDACTED]');
  });

  it('leaves non-sensitive data untouched', () => {
    const input = {
      organizationId: 'org_123',
      auditId: 'audit_456',
      status: 'completed',
      score: 87,
      nested: { count: 3, tags: ['a', 'b'] },
    };

    expect(redactSensitive(input)).toEqual(input);
  });

  it('does not mask an empty string (nothing to leak)', () => {
    const result = redactSensitive({ token: '' }) as Record<string, unknown>;

    expect(result.token).toBe('');
  });

  it('preserves null/undefined sensitive values instead of inventing a string', () => {
    const result = redactSensitive({
      password: null,
      token: undefined,
    }) as Record<string, unknown>;

    expect(result.password).toBeNull();
    expect(result.token).toBeUndefined();
  });

  it('serializes an Error without leaking extra own-properties beyond name/message/stack', () => {
    const error = new Error('boom');
    const result = redactSensitive(error) as Record<string, unknown>;

    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom');
    expect(typeof result.stack).toBe('string');
  });

  it('never throws on a circular structure', () => {
    const circular: Record<string, unknown> = { password: 'x' };
    circular.self = circular;

    expect(() => redactSensitive(circular)).not.toThrow();
    const result = redactSensitive(circular) as Record<string, unknown>;
    expect(result.password).toBe('[REDACTED]');
    expect(result.self).toBe('[Circular]');
  });

  it('passes primitives through unchanged', () => {
    expect(redactSensitive('plain string')).toBe('plain string');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(true)).toBe(true);
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it('scrubs a secret embedded in free text under a non-sensitive key', () => {
    const result = redactSensitive({
      message:
        'Invalid request from user-test@example.test, token=fake-token-abc123',
    }) as { message: string };

    expect(result.message).not.toContain('user-test@example.test');
    expect(result.message).not.toContain('fake-token-abc123');
  });

  it('scrubs a Bearer token and a JWT-shaped string embedded in free text', () => {
    const result = redactSensitive({
      message:
        'Upstream call failed with Authorization: Bearer fake.header.payload and cached JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakesignature',
    }) as { message: string };

    expect(result.message).not.toContain('fake.header.payload');
    expect(result.message).not.toContain(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakesignature',
    );
  });

  it('scrubs a secret inside a caught error message, not only its own message key', () => {
    const error = new Error(
      'Request failed: api_key=fake-api-key-xyz was rejected',
    );
    const result = redactSensitive(error) as Record<string, unknown>;

    expect(result.message).not.toContain('fake-api-key-xyz');
  });

  it('leaves ordinary free text untouched', () => {
    const result = redactSensitive({
      message: 'Audit completed with 12 pages crawled',
    }) as { message: string };

    expect(result.message).toBe('Audit completed with 12 pages crawled');
  });
});

describe('scrubText', () => {
  it('redacts an email address embedded in text', () => {
    expect(
      scrubText('contact fake-user@example.test for details'),
    ).not.toContain('fake-user@example.test');
  });

  it('redacts a Bearer token embedded in text', () => {
    expect(
      scrubText('sent Authorization: Bearer fake-secret-value'),
    ).not.toContain('fake-secret-value');
  });

  it('redacts an inline key=value secret embedded in text', () => {
    const result = scrubText(
      'retrying with token=fake-token-123 after failure',
    );
    expect(result).not.toContain('fake-token-123');
  });

  it('leaves text with no secret-shaped substring unchanged', () => {
    expect(scrubText('everything is fine here')).toBe(
      'everything is fine here',
    );
  });
});
