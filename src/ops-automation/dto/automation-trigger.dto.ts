import { IsIn, IsOptional, IsString } from 'class-validator';

export const AUTOMATION_TRIGGER_TYPES = [
  'manual',
  'scheduled',
  'event',
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export class AutomationTriggerDto {
  @IsIn(AUTOMATION_TRIGGER_TYPES)
  type!: AutomationTriggerType;

  // Required (and validated) at the service level when type === 'scheduled'.
  @IsOptional()
  @IsString()
  cronExpression?: string;

  // Required (and validated) at the service level when type === 'event'.
  @IsOptional()
  @IsString()
  eventType?: string;

  // IANA zone the cronExpression is evaluated in (e.g. "Europe/Paris").
  // Only meaningful for type === 'scheduled'; validated at the service
  // level. Defaults to "UTC" when omitted — never inferred from anything
  // else (see AutomationsService.validateTrigger()).
  @IsOptional()
  @IsString()
  timezone?: string;
}
