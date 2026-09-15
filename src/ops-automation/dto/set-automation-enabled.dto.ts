import { IsBoolean } from 'class-validator';

export class SetAutomationEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}
