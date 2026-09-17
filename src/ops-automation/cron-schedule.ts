import { CronExpressionParser } from 'cron-parser';

export class InvalidTimezoneError extends Error {
  constructor(timezone: string) {
    super(`"${timezone}" is not a valid IANA timezone.`);
  }
}

export class InvalidCronExpressionError extends Error {
  constructor(cronExpression: string, cause: string) {
    super(`"${cronExpression}" is not a valid cron expression: ${cause}`);
  }
}

// RC-25 review fix: cron-parser also accepts 6-field (with seconds) and
// "@daily"/"@weekly"-style shorthand expressions, but the dispatcher only
// ticks once a minute (@nestjs/schedule's EVERY_MINUTE) — a sub-minute
// expression would silently never fire at the frequency it claims to.
// Only the standard 5-field form (minute hour day-of-month month
// day-of-week) is accepted for RC25; this is checked before cron-parser
// ever sees the string, so the rejection reason is explicit rather than a
// cron-parser internal parse error.
function assertFiveFieldCronExpression(cronExpression: string): void {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronExpressionError(
      cronExpression,
      `expected exactly 5 space-separated fields (minute hour day-of-month month day-of-week), got ${fields.length} — 6-field (seconds) and "@..." shorthand expressions are not supported, since the dispatcher only resolves down to the minute.`,
    );
  }
}

// Intl is the standard, dependency-free way to validate an IANA zone in
// Node — cron-parser's own error on an invalid tz is an unhelpful internal
// message ("CronDate: unhandled timestamp: ..."), so this is checked
// first and reported with our own clear error instead of leaking that.
export function isValidIanaTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// The single source of truth for "when does this scheduled trigger next
// fire" — used both to validate a cron expression at create/update time
// (validateTrigger()) and by the dispatcher to compute the next nextRunAt
// after claiming an occurrence. Always anchored at `from` (normally "now"),
// never at the previous nextRunAt — that's what keeps a catch-up after
// downtime to a single run instead of a burst (see AutomationSchedulerService).
export function computeNextOccurrence(
  cronExpression: string,
  timezone: string,
  from: Date,
): Date {
  if (!isValidIanaTimeZone(timezone)) {
    throw new InvalidTimezoneError(timezone);
  }
  assertFiveFieldCronExpression(cronExpression);
  try {
    const expression = CronExpressionParser.parse(cronExpression, {
      tz: timezone,
      currentDate: from,
    });
    return expression.next().toDate();
  } catch (error) {
    throw new InvalidCronExpressionError(
      cronExpression,
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}
