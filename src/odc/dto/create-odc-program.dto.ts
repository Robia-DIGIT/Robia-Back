import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OdcFieldDto } from './odc-field.dto';
import { OdcCriterionDto } from './odc-criterion.dto';
import { OdcDocumentTypeDto } from './odc-document-type.dto';

// Program-definition arrays are small, hand-authored lists (form fields,
// scoring criteria, document types for one program) — bounded generously,
// the same defensive-cap posture as MAX_STEPS_PER_AUTOMATION, never expected
// to be reached in practice.
const MAX_DEFINITION_ITEMS = 50;

export class CreateOdcProgramDto {
  @IsString()
  @MinLength(1)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, hyphen-separated',
  })
  slug!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  opensAt?: string;

  @IsOptional()
  @IsDateString()
  closesAt?: string;

  @IsOptional()
  @IsBoolean()
  requireDualReview?: boolean;

  @IsOptional()
  @IsInt()
  decisionThreshold?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DEFINITION_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => OdcFieldDto)
  fields?: OdcFieldDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DEFINITION_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => OdcCriterionDto)
  criteria?: OdcCriterionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DEFINITION_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => OdcDocumentTypeDto)
  docTypes?: OdcDocumentTypeDto[];
}
