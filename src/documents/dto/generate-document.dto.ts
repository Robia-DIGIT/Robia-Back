import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DOCUMENT_TYPES = [
  'local_page',
  'faq',
  'meta',
  'gbp_post',
  'review_reply',
  'dev_brief',
  'checklist',
] as const;

export class ContentBriefDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  objective?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  audience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  locale?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  facts?: string[];
}

export class GenerateDocumentDto {
  @IsOptional()
  @IsString()
  opportunityId?: string;

  @IsOptional()
  @IsString()
  websiteId?: string;

  @IsOptional()
  @IsString()
  actionItemId?: string;

  @IsIn(DOCUMENT_TYPES)
  type!: (typeof DOCUMENT_TYPES)[number];

  @IsOptional()
  @ValidateNested()
  @Type(() => ContentBriefDto)
  brief?: ContentBriefDto;
}
