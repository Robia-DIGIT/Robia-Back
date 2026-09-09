import { IsString, Matches, MaxLength } from 'class-validator';

export class SelectGoogleAnalyticsPropertyDto {
  @IsString()
  @MaxLength(64)
  @Matches(/^\d+$/)
  propertyId!: string;
}
