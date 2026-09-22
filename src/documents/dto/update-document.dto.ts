import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpdateDocumentDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;

  @IsString()
  @MinLength(1)
  content!: string;
}
