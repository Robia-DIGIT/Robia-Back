import { IsOptional, IsString } from 'class-validator';

export class ReviewAutomationRunDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
