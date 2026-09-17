import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ProposedScoreLineDto {
  @IsString()
  @MinLength(1)
  criterionId!: string;

  @IsInt()
  @Min(0)
  proposedPoints!: number;

  @IsOptional()
  @IsString()
  rationale?: string;

  // 'ai' by default at the Prisma column level — only ever set here when a
  // human reviewer (not an AI pipeline) is the one proposing, so the
  // distinction survives into OdcScoreLine.proposedBy.
  @IsOptional()
  @IsIn(['ai', 'reviewer'])
  proposedBy?: 'ai' | 'reviewer';
}

// Writes ONLY OdcScoreLine.proposedPoints/proposedBy/rationale — never
// finalPoints, never OdcApplication.status. See
// OdcApplicationsService.proposeScores().
export class ProposeScoresDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProposedScoreLineDto)
  scores!: ProposedScoreLineDto[];
}
