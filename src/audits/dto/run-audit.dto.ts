import { IsString } from 'class-validator';

export class RunAuditDto {
  @IsString()
  websiteId!: string;
}