import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

// The only two fields the public portal ever accepts to start/resume a
// candidature. In particular: never organizationId, never applicantId,
// never a status — see OdcPublicService.start().
export class StartOdcApplicationDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;
}
