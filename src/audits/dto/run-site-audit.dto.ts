import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class RunSiteAuditDto {
  @IsString()
  websiteId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  maxDepth?: number;
}