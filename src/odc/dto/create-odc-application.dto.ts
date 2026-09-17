import { IsString, MinLength } from 'class-validator';

export class CreateOdcApplicationDto {
  @IsString()
  @MinLength(1)
  applicantId!: string;
}
