import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class FinalScoreLineDto {
  @IsString()
  @MinLength(1)
  criterionId!: string;

  @IsInt()
  @Min(0)
  finalPoints!: number;
}

// Human-only: writes OdcScoreLine.finalPoints, never proposedPoints, never
// OdcApplication.status. See OdcApplicationsService.updateFinalScores().
export class UpdateScoresDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FinalScoreLineDto)
  scores!: FinalScoreLineDto[];
}
