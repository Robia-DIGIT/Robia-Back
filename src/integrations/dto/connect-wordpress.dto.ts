import { IsString, Length } from 'class-validator';

export class ConnectWordPressDto {
  @IsString()
  websiteId!: string;

  @IsString()
  @Length(1, 128)
  username!: string;

  @IsString()
  @Length(8, 512)
  applicationPassword!: string;
}
