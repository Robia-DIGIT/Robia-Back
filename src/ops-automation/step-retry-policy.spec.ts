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
import {
  abandonedRunningClaimWhere,
  dueScheduledRetryWhere,
  dueStepRetryWhere,
  isPermanentStepError,
  legacyUnclaimedRunningWhere,
} from './step-retry-policy';

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

describe('dueStepRetryWhere (scan predicate)', () => {
  const now = new Date('2026-09-17T12:00:00.000Z');
  const stale = new Date('2026-09-17T11:55:00.000Z');

  function matches(record: {
    status: string;
    nextAttemptAt: Date | null;
    claimedAt: Date | null;
    claimToken?: string | null;
    startedAt?: Date | null;
  }): boolean {
    const where = dueStepRetryWhere(now, stale);
    return where.OR.some((branch) => {
      if (branch.status === 'retry_scheduled') {
        return (
          record.status === 'retry_scheduled' &&
          !!record.nextAttemptAt &&
          record.nextAttemptAt <= now
        );
      }
      if ('startedAt' in branch) {
        return (
          record.status === 'running' &&
          record.claimedAt === null &&
          (record.claimToken ?? null) === null &&
          !!record.startedAt &&
          record.startedAt < stale
        );
      }
      return (
        record.status === 'running' &&
        !!record.claimedAt &&
        record.claimedAt < stale
      );
    });
  }

  it('matches a due retry_scheduled step', () => {
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

  it('matches a running step whose claim has gone stale — first attempt or retry, crashed either way', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: new Date('2026-09-17T11:50:00.000Z'), // older than `stale`
      }),
    ).toBe(true);
  });

  it('never matches a running step whose claim is still fresh (an attempt actively in flight)', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: new Date('2026-09-17T11:59:00.000Z'),
      }),
    ).toBe(false);
  });

  it('never matches a succeeded/failed/queued step', () => {
    for (const status of ['succeeded', 'failed', 'queued', 'skipped']) {
      expect(matches({ status, nextAttemptAt: null, claimedAt: null })).toBe(
        false,
      );
    }
  });

  it('matches a legacy pre-RC27 running step with no claim at all, past the lease', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: null,
        claimToken: null,
        startedAt: new Date('2026-09-17T11:50:00.000Z'), // older than `stale`
      }),
    ).toBe(true);
  });

  it('never matches a recent legacy-shaped running step (startedAt still within the lease)', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: null,
        claimToken: null,
        startedAt: new Date('2026-09-17T11:59:00.000Z'),
      }),
    ).toBe(false);
  });

  it('never matches a running step that already holds a claim, via the legacy branch', () => {
    expect(
      matches({
        status: 'running',
        nextAttemptAt: null,
        claimedAt: new Date('2026-09-17T11:59:00.000Z'), // fresh claim
        claimToken: 'token',
        startedAt: new Date('2026-09-17T11:00:00.000Z'), // long past, irrelevant
      }),
    ).toBe(false);
  });
});

describe('legacyUnclaimedRunningWhere (pre-RC27 first attempts with no claim at all)', () => {
  const stale = new Date('2026-09-17T11:55:00.000Z');

  it('is exactly status=running, claimedAt=null, claimToken=null, with a stale startedAt', () => {
    expect(legacyUnclaimedRunningWhere(stale)).toEqual({
      status: 'running',
      claimedAt: null,
      claimToken: null,
      startedAt: { lt: stale },
    });
  });
});

describe('dueScheduledRetryWhere (claim #1 — always known retry-safe)', () => {
  const now = new Date('2026-09-17T12:00:00.000Z');

  it('is exactly status=retry_scheduled with nextAttemptAt due — no claimedAt condition', () => {
    expect(dueScheduledRetryWhere(now)).toEqual({
      status: 'retry_scheduled',
      nextAttemptAt: { lte: now },
    });
  });
});

describe('abandonedRunningClaimWhere (claim #2 — retry-safety re-checked by the caller)', () => {
  const stale = new Date('2026-09-17T11:55:00.000Z');

  it('is exactly status=running with a stale claimedAt', () => {
    expect(abandonedRunningClaimWhere(stale)).toEqual({
      status: 'running',
      claimedAt: { lt: stale },
    });
  });
});
