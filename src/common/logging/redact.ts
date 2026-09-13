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
 *
 * Key-based redaction alone lets a secret slip through when it is
 * embedded inside a free-text string under an innocuous key — an error
 * message like `Invalid token abc123 for user@example.com`, or a
 * breadcrumb message that happens to quote a request URL with
 * `?api_key=...` in it. Every string leaf this module encounters — not
 * only ones under a sensitive key — is therefore also passed through
 * `scrubText`, which pattern-matches likely secrets inside otherwise
 * ordinary text. This is the same redactor `sentry.ts` runs the whole
 * event through in `beforeSend`, so Sentry gets exactly this guarantee
 * too, not a separate/weaker one.
 */

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authorization|cookie|email)/i;

const REDACTED = '[REDACTED]';

// Fake-looking on purpose everywhere they appear in this file's comments
// and in redact.spec.ts / sentry.spec.ts — never a real credential.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const INLINE_SECRET_PATTERN =
  /\b(password|passwd|secret|token|api[-_]?key|authorization|cookie)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi;

/**
 * Best-effort scrubbing of secret-shaped substrings out of free text that
 * a key-based redactor cannot reach, because the secret is embedded
 * inside a string rather than sitting cleanly under its own key —
 * an exception message, a log message, a Sentry breadcrumb. It
 * complements key-based redaction; it does not replace it.
 */
export function scrubText(text: string): string {
  return text
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
    .replace(
      INLINE_SECRET_PATTERN,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    )
    .replace(EMAIL_PATTERN, REDACTED);
}

export function redactSensitive(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubText(value);
  }
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
      message: scrubText(value.message),
      stack: value.stack ? scrubText(value.stack) : value.stack,
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
