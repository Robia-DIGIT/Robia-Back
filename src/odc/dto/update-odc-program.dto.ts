import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OdcFieldDto } from './odc-field.dto';
import { OdcCriterionDto } from './odc-criterion.dto';
import { OdcDocumentTypeDto } from './odc-document-type.dto';

const MAX_DEFINITION_ITEMS = 50;

// Every field optional — a PATCH only ever touches what it carries.
// `fields`/`criteria`/`docTypes`, when present, wholesale-replace the
// program's current set (the same "immutable snapshot, no partial merge"
// posture as Automation.steps) — never a per-item upsert, so a PATCH always
// reflects exactly the definition list the caller intended, with no risk of
// a stale item surviving an edit that meant to remove it.
export class UpdateOdcProgramDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

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
