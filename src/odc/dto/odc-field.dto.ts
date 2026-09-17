import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export const ODC_FIELD_TYPES = [
  'text',
  'longtext',
  'number',
  'date',
  'select',
] as const;
export type OdcFieldType = (typeof ODC_FIELD_TYPES)[number];

export class OdcFieldDto {
  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  label!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsIn(ODC_FIELD_TYPES)
  fieldType!: OdcFieldType;

  // Only meaningful for fieldType 'select' — a plain array of option
  // strings, never validated further here (the same "structural hygiene
  // only, not per-value validation" posture as OpsActionsRegistryService's
  // objectInputFields).
  @IsOptional()
  options?: unknown;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
