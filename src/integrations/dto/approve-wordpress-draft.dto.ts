import { IsIn, IsInt, IsString, Min } from 'class-validator';

export class ApproveWordPressDraftDto {
  @IsString()
  websiteId!: string;

  @IsString()
  documentId!: string;

  @IsString()
  actionItemId!: string;

  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsIn(['post', 'page'])
  postType!: 'post' | 'page';
}
