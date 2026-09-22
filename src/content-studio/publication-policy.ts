import { createHash } from 'node:crypto';

/** Domain-only foundation. Not a controller, authorization check or DB lock.
 * All inputs must be reconstructed from tenant-scoped, trusted server records.
 * Re-evaluate inside the transaction that claims a publication attempt.
 */
export type ContentDestination = 'google_post' | 'wordpress_post';

export interface PublicationBinding {
  organizationId: string;
  documentId: string;
  revision: number;
  contentDigest: string;
  destination: ContentDestination;
  targetId: string;
  connectionVersion: number;
}

export interface PublicationApproval extends PublicationBinding {
  approvedBy: string;
  revoked: boolean;
}

export type PublicationAttemptState =
  'in_flight' | 'unknown' | 'confirmed' | 'failed';

export type PublicationDecision =
  | { allowed: true; operationKey: string }
  | {
      allowed: false;
      reason:
        | 'invalid_binding'
        | 'publishing_disabled'
        | 'connection_unavailable'
        | 'approval_required'
        | 'approval_stale'
        | 'already_confirmed'
        | 'reconciliation_required';
    };

function validBinding(binding: PublicationBinding): boolean {
  return (
    [binding.organizationId, binding.documentId, binding.targetId].every(
      (value) => typeof value === 'string' && value.trim().length > 0,
    ) &&
    Number.isSafeInteger(binding.revision) &&
    binding.revision > 0 &&
    Number.isSafeInteger(binding.connectionVersion) &&
    binding.connectionVersion > 0 &&
    /^[a-f0-9]{64}$/.test(binding.contentDigest) &&
    ['google_post', 'wordpress_post'].includes(binding.destination)
  );
}

/** Must hash the complete, canonical adapter payload (including media/CTA).
 * JSON array avoids separator collisions in user-provided identifiers.
 */
function operationKey(binding: PublicationBinding): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        binding.organizationId,
        binding.documentId,
        binding.revision,
        binding.contentDigest,
        binding.destination,
        binding.targetId,
        binding.connectionVersion,
      ]),
    )
    .digest('hex');
  return `content-publish:v1:${digest}`;
}

/** Fail closed. Neither an expired worker lease nor a timeout proves that a
 * remote POST did not succeed. Existing attempts require reconciliation; the
 * generic RC27 retry loop must not replay these external writes blindly.
 */
export function evaluatePublication(input: {
  current: PublicationBinding;
  approval: PublicationApproval | null;
  publishingEnabled: boolean;
  connectionReady: boolean;
  previousAttempt: PublicationAttemptState | null;
}): PublicationDecision {
  const { current, approval } = input;
  if (!validBinding(current)) {
    return { allowed: false, reason: 'invalid_binding' };
  }
  if (!input.publishingEnabled) {
    return { allowed: false, reason: 'publishing_disabled' };
  }
  if (!input.connectionReady) {
    return { allowed: false, reason: 'connection_unavailable' };
  }
  if (!approval || approval.revoked || !approval.approvedBy?.trim()) {
    return { allowed: false, reason: 'approval_required' };
  }
  if (
    !validBinding(approval) ||
    operationKey(current) !== operationKey(approval)
  ) {
    return { allowed: false, reason: 'approval_stale' };
  }
  if (input.previousAttempt === 'confirmed') {
    return { allowed: false, reason: 'already_confirmed' };
  }
  if (input.previousAttempt !== null) {
    return { allowed: false, reason: 'reconciliation_required' };
  }
  return { allowed: true, operationKey: operationKey(current) };
}
