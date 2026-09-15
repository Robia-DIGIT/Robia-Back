import { IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateCompetitorDto {
  @IsString()
  websiteId!: string;

  @IsUrl({ require_protocol: true })
  url!: string;

  @IsOptional()
  @IsString()
  name?: string;
}
