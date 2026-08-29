import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  company!: string;

  @Transform(normalizeEmail)
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
