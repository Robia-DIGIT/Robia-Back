import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards} from '@nestjs/common'; 
import type { Response } from 'express';
import { ActionItemsService } from './action-items.service';
import { UpdateActionStatusDto } from './dto/update-action-status.dto';
import { UpdateDueDateDto } from './dto/update-due-date.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { PdfExportService } from './pdf-export/pdf-export.service';
import { PrismaService } from '../prisma/prisma.service';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('actions')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class ActionItemsController {
  constructor(
    private readonly actionItemsService: ActionItemsService,
    private readonly pdfExportService: PdfExportService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('generate')
  generate(
    @Req() req: ScopedRequest,
    @Query('opportunity_id') opportunityId: string,
  ) {
    return this.actionItemsService.generateFromOpportunity(
      req.organizationId,
      opportunityId,
    );
  }

  @Get()
  findAll(@Req() req: ScopedRequest) {
    return this.actionItemsService.findAll(req.organizationId);
  }

  @Get('export')
  async exportPdf(@Req() req: ScopedRequest, @Res() res: Response) {
    const actions = await this.actionItemsService.getActionsForExport(
      req.organizationId,
    );
    const organization = await this.prisma.organization.findUnique({
      where: { id: req.organizationId },
      select: { name: true },
    });

    const pdfDoc = this.pdfExportService.generateActionPlanPdf(
      organization?.name ?? 'Organisation',
      actions,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="plan-action.pdf"',
    );

    pdfDoc.pipe(res);
  }

  @Patch(':id/status')
  updateStatus(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateActionStatusDto,
  ) {
    return this.actionItemsService.updateStatus(
      req.organizationId,
      id,
      dto,
    );
  }

  @Post('plan')
  generatePlan(@Req() req: ScopedRequest) {
    return this.actionItemsService.generatePlan(req.organizationId);
  }

  @Patch(':id/due-date')
  updateDueDate(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDueDateDto,
  ) {
    return this.actionItemsService.updateDueDate(
      req.organizationId,
      id,
      new Date(dto.dueDate),
    );
  }
}
