import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { OdcPublicService } from './odc-public.service';
import { StartOdcApplicationDto } from './dto/start-odc-application.dto';
import { UpdateOdcApplicationDto } from './dto/update-odc-application.dto';
import { UploadOdcDocumentDto } from './dto/upload-odc-document.dto';
import { WithdrawApplicationDto } from './dto/withdraw-application.dto';
import { MAX_ODC_UPLOAD_BYTES } from './storage/odc-storage';

// RC-49 — deliberately NO JwtAuthGuard/OrgScopeGuard: an applicant has no
// RobIA account. Authentication is the per-application magic-link token in
// the URL itself, verified inside OdcPublicService — never a JWT, never an
// organizationId taken from the caller. This controller has no route named
// decide/scores/outreach/listByProgram/open/close, and no route that could
// ever reach one — see OdcPublicService's own doc comment for the full list
// of boundaries it enforces.
@Controller('odc/public')
export class OdcPublicController {
  constructor(private readonly service: OdcPublicService) {}

  @Get('programs/:publicKey')
  getProgram(@Param('publicKey') publicKey: string) {
    return this.service.getProgram(publicKey);
  }

  // Same limit as AuthService's own sensitive routes (forgotPassword,
  // login, ...) — see AuthController.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('programs/:publicKey/start')
  start(
    @Param('publicKey') publicKey: string,
    @Body() dto: StartOdcApplicationDto,
  ) {
    return this.service.start(publicKey, dto);
  }

  @Get('applications/:token')
  getApplication(@Param('token') token: string) {
    return this.service.getApplication(token);
  }

  @Patch('applications/:token/answers')
  updateAnswers(
    @Param('token') token: string,
    @Body() dto: UpdateOdcApplicationDto,
  ) {
    return this.service.updateAnswers(token, dto);
  }

  // `dto` only ever carries `documentTypeId` — anything else in the
  // multipart body (a `storageKey` in particular) is rejected by the global
  // ValidationPipe before this method ever runs, same guarantee as the
  // staff-facing upload route.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('applications/:token/documents/upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ODC_UPLOAD_BYTES } }),
  )
  uploadDocument(
    @Param('token') token: string,
    @Body() dto: UploadOdcDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file received.');
    }
    return this.service.upload(token, dto.documentTypeId, file);
  }

  @Post('applications/:token/submit')
  submit(@Param('token') token: string) {
    return this.service.submit(token);
  }

  @Post('applications/:token/withdraw')
  withdraw(@Param('token') token: string, @Body() dto: WithdrawApplicationDto) {
    return this.service.withdraw(token, dto);
  }
}
