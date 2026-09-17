import { IsString, MinLength } from 'class-validator';

// The multipart body's only allowed non-file field. The global
// ValidationPipe's `whitelist`/`forbidNonWhitelisted` rejects anything else
// sent alongside it — in particular a client-supplied `storageKey`, which
// must never reach OdcDocumentsService.upload() (see
// docs/RC33_ODC_UPLOAD.md).
export class UploadOdcDocumentDto {
  @IsString()
  @MinLength(1)
  documentTypeId!: string;
}
