import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { OdcProgramsService } from './odc-programs.service';
import { OdcApplicationsService } from './odc-applications.service';
import { CreateOdcProgramDto } from './dto/create-odc-program.dto';
import { UpdateOdcProgramDto } from './dto/update-odc-program.dto';
import { CreateOdcApplicantDto } from './dto/create-odc-applicant.dto';
import { CreateOdcApplicationDto } from './dto/create-odc-application.dto';
import { UpdateOdcApplicationDto } from './dto/update-odc-application.dto';
import { CreateOdcDocumentDto } from './dto/create-odc-document.dto';
import { ProposeSummaryDto } from './dto/propose-summary.dto';
import { ProposeScoresDto } from './dto/propose-scores.dto';
import { UpdateScoresDto } from './dto/update-scores.dto';
import { DecideApplicationDto } from './dto/decide-application.dto';
import { WithdrawApplicationDto } from './dto/withdraw-application.dto';

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
