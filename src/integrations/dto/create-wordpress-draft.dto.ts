import { IsString, Length } from 'class-validator';

export class CreateWordPressDraftDto {
  @IsString()
  approvalId!: string;

  @IsString()
  @Length(8, 128)
  idempotencyKey!: string;
}
