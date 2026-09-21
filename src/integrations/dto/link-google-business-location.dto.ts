import { IsString } from 'class-validator';

export class LinkGoogleBusinessLocationDto {
  @IsString()
  robiaLocationId!: string;
}
