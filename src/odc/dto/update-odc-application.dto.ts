import { IsObject } from 'class-validator';

// Merged into the application's existing `answers` (never a wholesale
// replace) — see OdcApplicationsService.updateAnswers(). Only allowed while
// status is draft/incomplete; the service enforces that, not this DTO.
export class UpdateOdcApplicationDto {
  @IsObject()
  answers!: Record<string, unknown>;
}
