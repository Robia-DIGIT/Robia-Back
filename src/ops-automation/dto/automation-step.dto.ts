import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class AutomationStepDto {
  // Must resolve against the Ops action registry — checked at the service
  // level (AutomationsService), not here: the DTO layer only knows it is a
  // non-empty string, not which action types currently exist.
  @IsString()
  @MinLength(1)
  actionType!: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
