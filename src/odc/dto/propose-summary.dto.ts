import { IsString, MinLength } from 'class-validator';

// The summary text itself is always caller-supplied (a reviewer, or a
// future dedicated AI pipeline external to this RC) — this endpoint only
// ever persists it to summaryDraft, it never generates text server-side and
// never touches status. See docs/RC29_ODC_CANDIDATURES.md.
export class ProposeSummaryDto {
  @IsString()
  @MinLength(1)
  summaryDraft!: string;
}
