import { IsInt, IsString, Min, MinLength } from 'class-validator';

// RC-33 hardening — no `storageKey` field, deliberately: this DTO backs the
// public metadata-only route (POST .../documents), and a client-supplied
// storageKey there let any caller point a document row at an arbitrary key
// — including another organization's real file — that the download route
// would then serve back to them. This route can now only ever register a
// 'pending_upload' placeholder; the global ValidationPipe's
// forbidNonWhitelisted rejects a storageKey field outright if a caller
// still sends one. The real upload path (POST .../documents/upload) is the
// only way a document ever reaches 'received' — see
// OdcDocumentsService.upload() and OdcApplicationsService.addUploadedDocument(),
// which computes its own server-generated storageKey and is never reachable
// from any DTO a client controls.
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
}
