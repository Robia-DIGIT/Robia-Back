/**
 * Deep, key-based redaction for anything about to be logged.
 *
 * Unlike pino's built-in `redact` option (which only masks a fixed list
 * of exact JSON paths you must enumerate up front), this walks the whole
 * object graph and masks any key that *looks* sensitive regardless of
 * where it appears — a `password` nested three levels deep inside a
 * request body is caught the same as `req.headers.authorization`.
 *
 * Scope, per the RC-15 plan: passwords, tokens, secrets, API keys,
 * authorization headers, cookies, and emails.
 */

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authorization|cookie|email)/i;

const REDACTED = '[REDACTED]';

export function redactSensitive(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = redactLeafValue(entry);
    } else {
      result[key] = redact(entry, seen);
    }
  }
  return result;
}

function redactLeafValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' && value.length === 0) {
    return value;
  }
  return REDACTED;
}
