import { IsIn } from 'class-validator';

export class CreateCheckoutSessionDto {
  @IsIn(['monthly', 'annual'])
  billingPeriod!: 'monthly' | 'annual';
}
