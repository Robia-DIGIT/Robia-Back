import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AutomationTriggerDto } from './automation-trigger.dto';
import { AutomationStepDto } from './automation-step.dto';
import type { ConditionNode } from '../condition-engine';
import {
  AUTOMATION_SCOPES,
  MAX_STEPS_PER_AUTOMATION,
  type AutomationScope,
} from '../automation.constants';

export class CreateAutomationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  // RC-29 — defaults to 'ORGANIZATION' (the Postgres column default) when
  // omitted, exactly as before this field existed. 'PROGRAM'/'COHORT' let an
  // Orange Digital Center automation (e.g. the "candidatures in_review depuis
  // N jours" reminder — see docs/RC29_ODC_CANDIDATURES.md) categorize itself
  // apart from a PME's own 'ORGANIZATION'-scoped automations, without this
  // service ever filtering by scope — organizationId alone remains the only
  // enforced isolation boundary.
  @IsOptional()
  @IsIn(AUTOMATION_SCOPES)
  scope?: AutomationScope;

  @ValidateNested()
  @Type(() => AutomationTriggerDto)
  trigger!: AutomationTriggerDto;

  // Structured condition tree — see condition-engine.ts. Validated against
  // the field/operator allowlist in the service, not by class-validator
  // (the shape is a recursive union, not a fixed class).
  @IsOptional()
  @IsObject()
  conditions?: ConditionNode;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STEPS_PER_AUTOMATION)
  @ValidateNested({ each: true })
  @Type(() => AutomationStepDto)
  steps!: AutomationStepDto[];

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
