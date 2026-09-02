import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateLocationDto {
  // Si fourni, les champs adresse/coordonnées/horaires sont pré-remplis
  // automatiquement via Google Places (peuvent être surchargés ci-dessous).
  @IsOptional()
  @IsString()
  placeId?: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}