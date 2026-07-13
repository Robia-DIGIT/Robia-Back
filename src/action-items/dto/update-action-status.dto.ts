import { IsIn } from 'class-validator';

const STATUSES = ['todo', 'in_progress', 'done', 'blocked', 'ignored'] as const;

export class UpdateActionStatusDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];
}