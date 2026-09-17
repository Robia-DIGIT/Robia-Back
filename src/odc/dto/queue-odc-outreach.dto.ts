import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

const MAX_OUTREACH_BATCH = 50;

export class QueueOdcOutreachDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OUTREACH_BATCH)
  @IsString({ each: true })
  applicationIds!: string[];
}
