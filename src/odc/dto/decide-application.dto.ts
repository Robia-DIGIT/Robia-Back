import { IsIn, IsString, MinLength } from 'class-validator';

export const ODC_DECISIONS = ['accepted', 'rejected', 'waitlisted'] as const;
export type OdcDecision = (typeof ODC_DECISIONS)[number];

// The only DTO that can ever move a candidature to accepted/rejected/
// waitlisted — always via a human caller (OdcController), never from an
// automation or action. `decisionReason` is required and validated
// non-empty here AND re-checked in the service (never trust a single layer
// for a rule this load-bearing).
export class DecideApplicationDto {
  @IsIn(ODC_DECISIONS)
  decision!: OdcDecision;

  @IsString()
  @MinLength(1)
  decisionReason!: string;
}
