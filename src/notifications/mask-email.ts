// RC-26 — partial masking for display/evidence, distinct from
// redactSensitive() (src/common/logging/redact.ts): that helper fully
// replaces an email with "[REDACTED]", which is correct for logs/errors but
// useless for an ops dashboard or an action's own evidence, where an
// operator needs to recognize *which* address a delivery went to without
// ever seeing the full address. `j***@example.com` keeps the domain and a
// single leading character, dropping everything else.
export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) {
    return '***';
  }
  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  return `${localPart[0]}***@${domain}`;
}
