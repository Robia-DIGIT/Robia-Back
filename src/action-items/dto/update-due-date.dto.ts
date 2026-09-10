import { IsDateString } from 'class-validator';

export class UpdateDueDateDto {
  @IsDateString()
  dueDate!: string;
}
