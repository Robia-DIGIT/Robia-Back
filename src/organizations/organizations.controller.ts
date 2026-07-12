import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string };
}

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationsService.create(req.user.userId, dto);
  }

  @Get('current')
  findCurrent(@Req() req: AuthenticatedRequest) {
    return this.organizationsService.findCurrent(req.user.userId);
  }

  @Patch('current')
  updateCurrent(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateCurrent(req.user.userId, dto);
  }
}