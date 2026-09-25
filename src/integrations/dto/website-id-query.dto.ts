import { IsString, Length } from 'class-validator';

export class WebsiteIdQueryDto {
  @IsString()
  @Length(1, 128)
  websiteId!: string;
}
