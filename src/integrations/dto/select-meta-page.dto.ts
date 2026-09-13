import { IsString, MinLength } from 'class-validator';

export class SelectMetaPageDto {
  @IsString()
  @MinLength(1)
  pageId!: string;
}
