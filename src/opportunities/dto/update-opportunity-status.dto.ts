import { IsIn } from 'class-validator';

const STATUSES = ['open', 'in_progress', 'done', 'ignored'] as const;

export class UpdateOpportunityStatusDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];
}
