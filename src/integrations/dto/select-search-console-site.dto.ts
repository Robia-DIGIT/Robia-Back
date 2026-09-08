import { IsString, MaxLength, MinLength } from 'class-validator';

export class SelectSearchConsoleSiteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  siteUrl!: string;
}
