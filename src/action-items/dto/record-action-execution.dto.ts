import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const OUTCOMES = ['succeeded', 'failed'] as const;

export class RecordActionExecutionDto {
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotencyKey!: string;

  @IsIn(OUTCOMES)
  outcome!: (typeof OUTCOMES)[number];

  @IsObject()
  evidence!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsString()
  verificationAuditId?: string;
}
