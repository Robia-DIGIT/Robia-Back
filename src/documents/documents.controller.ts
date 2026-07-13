import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { GenerateDocumentDto } from './dto/generate-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('documents')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('generate')
  generate(@Req() req: ScopedRequest, @Body() dto: GenerateDocumentDto) {
    return this.documentsService.generate(req.organizationId, dto);
  }

  @Get()
  findAllByOpportunity(
    @Req() req: ScopedRequest,
    @Query('opportunity_id') opportunityId: string,
  ) {
    return this.documentsService.findAllByOpportunity(
      req.organizationId,
      opportunityId,
    );
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.documentsService.findOne(req.organizationId, id);
  }

  @Patch(':id')
  update(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documentsService.update(req.organizationId, id, dto);
  }
}
