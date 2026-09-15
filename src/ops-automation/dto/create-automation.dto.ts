import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AutomationTriggerDto } from './automation-trigger.dto';
import { AutomationStepDto } from './automation-step.dto';
import type { ConditionNode } from '../condition-engine';
import { MAX_STEPS_PER_AUTOMATION } from '../automation.constants';

export class CreateAutomationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

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
