import { IsInt, IsString, Min, MinLength } from 'class-validator';

export class UpdateDocumentDto {
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsString()
  @MinLength(1)
  content!: string;
}
