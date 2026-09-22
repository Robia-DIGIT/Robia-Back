import {
  evaluatePublication,
  PublicationApproval,
  PublicationBinding,
} from './publication-policy';

const binding: PublicationBinding = {
  organizationId: 'org-a',
  documentId: 'doc-a',
  revision: 1,
  contentDigest: 'a'.repeat(64),
  destination: 'google_post',
  targetId: 'location-a',
  connectionVersion: 1,
};

const approval: PublicationApproval = {
  ...binding,
  approvedBy: 'user-a',
  revoked: false,
};

const input = {
  current: binding,
  approval,
  publishingEnabled: true,
  connectionReady: true,
  previousAttempt: null,
};

describe('Content Studio publication policy (foundation only)', () => {
  it('permits the exact approved payload and produces a stable opaque key', () => {
    const decision = evaluatePublication(input);
    expect(decision).toEqual(evaluatePublication(input));
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('Expected an eligible publication');
    expect(decision.operationKey).toMatch(/^content-publish:v1:[a-f0-9]{64}$/);
  });

  it('supports WordPress independently of Google', () => {
    const current: PublicationBinding = {
      ...binding,
      destination: 'wordpress_post',
    };
    expect(
      evaluatePublication({
        ...input,
        current,
        approval: { ...approval, ...current },
      }).allowed,
    ).toBe(true);
  });

  it.each([
    { organizationId: 'org-b' },
    { documentId: 'doc-b' },
    { revision: 2 },
    { contentDigest: 'b'.repeat(64) },
    { destination: 'wordpress_post' as const },
    { targetId: 'location-b' },
    { connectionVersion: 2 },
  ])('invalidates approval when a binding changes: %j', (patch) => {
    expect(
      evaluatePublication({ ...input, current: { ...binding, ...patch } }),
    ).toEqual({ allowed: false, reason: 'approval_stale' });
  });

  it.each([
    { organizationId: '' },
    { targetId: ' ' },
    { revision: 0 },
    { revision: 1.5 },
    { revision: Number.NaN },
    { connectionVersion: 0 },
    { contentDigest: 'not-a-digest' },
  ])('rejects an invalid binding: %j', (patch) => {
    expect(
      evaluatePublication({ ...input, current: { ...binding, ...patch } }),
    ).toEqual({ allowed: false, reason: 'invalid_binding' });
  });

  it('does not treat an OAuth connection as publication consent', () => {
    expect(evaluatePublication({ ...input, approval: null })).toEqual({
      allowed: false,
      reason: 'approval_required',
    });
  });

  it.each([{ revoked: true }, { approvedBy: '' }])(
    'requires an attributable, unrevoked approval: %j',
    (patch) => {
      expect(
        evaluatePublication({ ...input, approval: { ...approval, ...patch } }),
      ).toEqual({ allowed: false, reason: 'approval_required' });
    },
  );

  it('honors the deployment kill switch', () => {
    expect(evaluatePublication({ ...input, publishingEnabled: false })).toEqual(
      { allowed: false, reason: 'publishing_disabled' },
    );
  });

  it('blocks a disconnected or unavailable destination', () => {
    expect(evaluatePublication({ ...input, connectionReady: false })).toEqual({
      allowed: false,
      reason: 'connection_unavailable',
    });
  });

  it.each(['in_flight', 'unknown', 'failed'] as const)(
    'never blindly replays a previous %s attempt',
    (previousAttempt) => {
      expect(evaluatePublication({ ...input, previousAttempt })).toEqual({
        allowed: false,
        reason: 'reconciliation_required',
      });
    },
  );

  it('does not publish twice after confirmation', () => {
    expect(
      evaluatePublication({ ...input, previousAttempt: 'confirmed' }),
    ).toEqual({ allowed: false, reason: 'already_confirmed' });
  });
});
