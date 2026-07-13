import { IsUrl } from 'class-validator';

export class CreateWebsiteDto {
  @IsUrl({ require_protocol: true })
  url!: string;
}
