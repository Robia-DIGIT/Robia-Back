import { IsIn, IsString } from 'class-validator';

const DOCUMENT_TYPES = [
  'local_page',
  'faq',
  'meta',
  'gbp_post',
  'review_reply',
  'dev_brief',
  'checklist',
] as const;

export class GenerateDocumentDto {
  @IsString()
  opportunityId!: string;

  @IsIn(DOCUMENT_TYPES)
  type!: (typeof DOCUMENT_TYPES)[number];
}
