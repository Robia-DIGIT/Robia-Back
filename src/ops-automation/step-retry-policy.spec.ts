import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  InvalidOpsActionInputError,
  UnknownOpsActionError,
} from './actions/ops-actions-registry.service';
import { dueStepRetryWhere, isPermanentStepError } from './step-retry-policy';

describe('isPermanentStepError', () => {
  it('treats InvalidOpsActionInputError as permanent', () => {
    expect(
      isPermanentStepError(new InvalidOpsActionInputError('bad input')),
    ).toBe(true);
  });

  it('treats UnknownOpsActionError as permanent', () => {
    expect(isPermanentStepError(new UnknownOpsActionError('unknown'))).toBe(
      true,
    );
  });

  it('treats a 404 HttpException as permanent', () => {
    expect(isPermanentStepError(new NotFoundException('not found'))).toBe(true);
  });

  it('treats a 400 HttpException as permanent', () => {
    expect(isPermanentStepError(new BadRequestException('bad request'))).toBe(
      true,
    );
  });

  it('treats a 403 HttpException as permanent', () => {
    expect(isPermanentStepError(new ForbiddenException('forbidden'))).toBe(
      true,
    );
  });

  it('treats a 5xx HttpException as retryable, not permanent', () => {
    expect(isPermanentStepError(new InternalServerErrorException('boom'))).toBe(
      false,
    );
  });

  it('treats a plain Error as retryable, not permanent (unknown failures are never assumed permanent)', () => {
    expect(isPermanentStepError(new Error('ECONNRESET'))).toBe(false);
  });

  it('treats a non-Error thrown value as retryable, not permanent', () => {
    expect(isPermanentStepError('a string was thrown')).toBe(false);
  });
});

describe('dueStepRetryWhere', () => {
  const now = new Date('2026-09-17T12:00:00.000Z');
  const stale = new Date('2026-09-17T11:55:00.000Z');

  function matches(record: Record<string, unknown>): boolean {
    const where = dueStepRetryWhere(now, stale);
    return where.AND.every((clause) => {
      if (!('OR' in clause)) return true;
      return clause.OR.some((branch: Record<string, unknown>) =>
        Object.entries(branch).every(([key, condition]) => {
          const value = record[key];
          if (condition === null) return value === null;
          if (condition && typeof condition === 'object') {
            const cond = condition as { lte?: Date; lt?: Date; not?: null };
            if (cond.lte) return !!value && (value as Date) <= cond.lte;
            if (cond.lt) return !!value && (value as Date) < cond.lt;
            if ('not' in cond) return value !== cond.not;
          }
          return value === condition;
        }),
      );
    });
  }

  it('matches a due, unclaimed retry_scheduled step', () => {
    expect(
      matches({
        status: 'retry_scheduled',
        nextAttemptAt: new Date('2026-09-17T11:59:00.000Z'),
        claimedAt: null,
      }),
    ).toBe(true);
  });

  it('does not match a retry_scheduled step whose nextAttemptAt is still in the future', () => {
    expect(
      matches({
        status: 'retry_scheduled',
        nextAttemptAt: new Date('2026-09-17T12:01:00.000Z'),
        claimedAt: null,
      }),
    ).toBe(false);
  });

  it('does not match a retry_scheduled step whose lease is actively held', () => {
    expect(
      matches({
        status: 'retry_scheduled',
        nextAttemptAt: new Date('2026-09-17T11:59:00.000Z'),
        claimedAt: new Date('2026-09-17T11:58:00.000Z'), // fresh, not stale
      }),
    ).toBe(false);
  });

  it('matches a running step whose claim has gone stale (a crash mid-retry)', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: new Date('2026-09-17T11:50:00.000Z'), // older than `stale`
      }),
    ).toBe(true);
  });

  it('never matches a running step whose claim is fresh (a retry actively in flight)', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: new Date('2026-09-17T11:59:00.000Z'),
      }),
    ).toBe(false);
  });

  it('never matches a running step with no claim at all — the initial synchronous attempt, not an abandoned retry', () => {
    expect(
      matches({ status: 'running', nextAttemptAt: null, claimedAt: null }),
    ).toBe(false);
  });

  it('never matches a succeeded/failed/queued step', () => {
    for (const status of ['succeeded', 'failed', 'queued', 'skipped']) {
      expect(matches({ status, nextAttemptAt: null, claimedAt: null })).toBe(
        false,
      );
    }
  });
});
