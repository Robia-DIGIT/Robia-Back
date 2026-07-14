import { IsString } from 'class-validator';

export class GenerateOpportunitiesDto {
  @IsString()
  auditId!: string;
}