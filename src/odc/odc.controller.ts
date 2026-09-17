import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { OdcProgramsService } from './odc-programs.service';
import { OdcApplicationsService } from './odc-applications.service';
import { OdcDocumentsService } from './odc-documents.service';
import { CreateOdcProgramDto } from './dto/create-odc-program.dto';
import { UpdateOdcProgramDto } from './dto/update-odc-program.dto';
import { CreateOdcApplicantDto } from './dto/create-odc-applicant.dto';
import { CreateOdcApplicationDto } from './dto/create-odc-application.dto';
import { UpdateOdcApplicationDto } from './dto/update-odc-application.dto';
import { CreateOdcDocumentDto } from './dto/create-odc-document.dto';
import { UploadOdcDocumentDto } from './dto/upload-odc-document.dto';
import { ProposeSummaryDto } from './dto/propose-summary.dto';
import { ProposeScoresDto } from './dto/propose-scores.dto';
import { UpdateScoresDto } from './dto/update-scores.dto';
import { DecideApplicationDto } from './dto/decide-application.dto';
import { WithdrawApplicationDto } from './dto/withdraw-application.dto';
import { OdcOutreachService } from './odc-outreach.service';
import { QueueOdcOutreachDto } from './dto/queue-odc-outreach.dto';
import { MAX_ODC_UPLOAD_BYTES } from './storage/odc-storage';
import { sanitizeContentDispositionFilename } from './storage/odc-storage-key';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

// RC-29 — every route here is org-scoped (JwtAuthGuard + OrgScopeGuard, the
// same pattern as AutomationsController/ActionItemsController). There is no
// route named "execute" or "apply" a decision, and no route at all reaches
// accepted/rejected/waitlisted except decide() — see
// docs/RC29_ODC_CANDIDATURES.md.
@Controller('odc')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class OdcController {
  constructor(
    private readonly programs: OdcProgramsService,
    private readonly applications: OdcApplicationsService,
    private readonly outreach: OdcOutreachService,
    private readonly documents: OdcDocumentsService,
  ) {}

  // ---------------------------------------------------------------------
  // Programs
  // ---------------------------------------------------------------------

  @Post('programs')
  createProgram(@Req() req: ScopedRequest, @Body() dto: CreateOdcProgramDto) {
    return this.programs.create(req.organizationId, req.user.userId, dto);
  }

  @Get('programs')
  listPrograms(@Req() req: ScopedRequest) {
    return this.programs.findAll(req.organizationId);
  }

  @Get('programs/:id')
  getProgram(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.programs.findOne(req.organizationId, id);
  }

  @Get('programs/:id/applications')
  listApplications(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.applications.listByProgram(req.organizationId, id);
  }

  @Patch('programs/:id')
  updateProgram(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateOdcProgramDto,
  ) {
    return this.programs.update(req.organizationId, id, dto);
  }

  @Post('programs/:id/open')
  openProgram(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.programs.open(req.organizationId, id);
  }

  @Post('programs/:id/close')
  closeProgram(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.programs.close(req.organizationId, id);
  }

  @Get('programs/:id/outreach')
  listOutreach(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.outreach.list(req.organizationId, id);
  }

  @Post('programs/:id/outreach')
  queueOutreach(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: QueueOdcOutreachDto,
  ) {
    return this.outreach.queue(req.organizationId, id, dto);
  }

  @Post('outreach/:id/send')
  sendOutreach(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.outreach.send(req.organizationId, req.user.userId, id);
  }

  @Post('outreach/:id/skip')
  skipOutreach(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.outreach.skip(req.organizationId, req.user.userId, id);
  }

  // ---------------------------------------------------------------------
  // Applicants
  // ---------------------------------------------------------------------

  @Post('applicants')
  createApplicant(
    @Req() req: ScopedRequest,
    @Body() dto: CreateOdcApplicantDto,
  ) {
    return this.applications.createApplicant(req.organizationId, dto);
  }

  // ---------------------------------------------------------------------
  // Applications
  // ---------------------------------------------------------------------

  @Post('programs/:id/applications')
  createApplication(
    @Req() req: ScopedRequest,
    @Param('id') programId: string,
    @Body() dto: CreateOdcApplicationDto,
  ) {
    return this.applications.createApplication(
      req.organizationId,
      programId,
      dto,
    );
  }

  @Get('applications/:id')
  getApplication(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.applications.getApplication(req.organizationId, id);
  }

  @Get('applications/:id/history')
  getHistory(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.applications.getHistory(req.organizationId, id);
  }

  @Patch('applications/:id')
  updateApplication(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateOdcApplicationDto,
  ) {
    return this.applications.updateAnswers(req.organizationId, id, dto);
  }

  @Post('applications/:id/documents')
  addDocument(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: CreateOdcDocumentDto,
  ) {
    return this.applications.addDocument(req.organizationId, id, dto);
  }

  // RC-33 — the real-upload path. `dto` only ever carries `documentTypeId`;
  // anything else in the multipart body (a `storageKey` in particular) is
  // rejected by the global ValidationPipe before this method ever runs.
  @Post('applications/:id/documents/upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ODC_UPLOAD_BYTES } }),
  )
  uploadDocument(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UploadOdcDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file received.');
    }
    return this.documents.upload(
      req.organizationId,
      id,
      dto.documentTypeId,
      file,
    );
  }

  // Streamed, never buffered whole into memory. 404 (never 403) whenever
  // the document doesn't resolve to a real, received file for this
  // organization — see OdcDocumentsService.getFile()'s own doc comment.
  @Get('documents/:documentId/file')
  async getDocumentFile(
    @Req() req: ScopedRequest,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ) {
    const { document, stream } = await this.documents.getFile(
      req.organizationId,
      documentId,
    );
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeContentDispositionFilename(document.originalName)}"`,
    );
    stream.pipe(res);
  }

  @Post('applications/:id/submit')
  submit(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.applications.submit(req.organizationId, req.user.userId, id);
  }

  @Post('applications/:id/propose-summary')
  proposeSummary(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: ProposeSummaryDto,
  ) {
    return this.applications.proposeSummary(req.organizationId, id, dto);
  }

  @Post('applications/:id/propose-scores')
  proposeScores(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: ProposeScoresDto,
  ) {
    return this.applications.proposeScores(req.organizationId, id, dto);
  }

  @Patch('applications/:id/scores')
  updateScores(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateScoresDto,
  ) {
    return this.applications.updateFinalScores(req.organizationId, id, dto);
  }

  @Post('applications/:id/decide')
  decide(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: DecideApplicationDto,
  ) {
    return this.applications.decide(
      req.organizationId,
      req.user.userId,
      id,
      dto,
    );
  }

  @Post('applications/:id/withdraw')
  withdraw(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: WithdrawApplicationDto,
  ) {
    return this.applications.withdraw(
      req.organizationId,
      req.user.userId,
      id,
      dto,
    );
  }
}
