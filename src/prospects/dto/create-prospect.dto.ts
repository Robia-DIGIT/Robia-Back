import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trimOptional = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed || undefined;
};

export class CreateProspectDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trimOptional)
  @IsOptional()
  @IsString()
  @Matches(/^[0-9+().\s-]{6,30}$/)
  phone?: string;

  @Transform(trimOptional)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  company?: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;

  // Champ invisible pour bloquer silencieusement les robots qui remplissent tout.
  @Transform(trimOptional)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
