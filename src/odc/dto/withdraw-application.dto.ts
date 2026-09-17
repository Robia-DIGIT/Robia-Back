import { IsString, MinLength } from 'class-validator';

export class WithdrawApplicationDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
