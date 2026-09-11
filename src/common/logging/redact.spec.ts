import { redactSensitive } from './redact';

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
});
