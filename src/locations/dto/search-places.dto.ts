import { IsString, MinLength } from 'class-validator';

export class SearchPlacesDto {
  @IsString()
  @MinLength(2)
  query!: string;
}