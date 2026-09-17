import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateOdcDocumentDto {
  @IsString()
  @MinLength(1)
  documentTypeId!: string;

  @IsString()
  @MinLength(1)
  originalName!: string;

  @IsString()
  @MinLength(1)
  mimeType!: string;

  @IsInt()
  @Min(0)
  sizeBytes!: number;

  // Optional in v1: no real storage backend is wired up yet. Absent ->
  // status starts at 'pending_upload'; present -> 'received'. See
  // OdcApplicationsService.addDocument().
  @IsOptional()
  @IsString()
  @MinLength(1)
  storageKey?: string;
}
