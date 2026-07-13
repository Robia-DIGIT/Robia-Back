import { IsIn, IsOptional, IsString } from 'class-validator';

const ACTION_TYPES = ['publish', 'update', 'reply'] as const;
const STATUSES = ['approved', 'rejected'] as const;

export class CreateValidationLogDto {
  @IsString()
  documentId!: string;

  @IsIn(ACTION_TYPES)
  actionType!: (typeof ACTION_TYPES)[number];

  @IsOptional()
  @IsString()
  platform?: string;

  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];
}