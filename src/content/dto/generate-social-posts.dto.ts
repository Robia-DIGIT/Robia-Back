import { IsString } from 'class-validator';

export class GenerateSocialPostsDto {
  @IsString()
  locationId!: string;
}