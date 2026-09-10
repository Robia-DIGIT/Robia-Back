import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CreateProspectDto } from './dto/create-prospect.dto';
import { ProspectsService } from './prospects.service';

@Controller('prospects')
export class ProspectsController {
  constructor(private readonly prospectsService: ProspectsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submit(@Body() dto: CreateProspectDto, @Req() request: Request) {
    return this.prospectsService.submit(dto, this.clientAddress(request));
  }

  private clientAddress(request: Request) {
    const value = request.headers['x-forwarded-for'];
    const forwarded = Array.isArray(value) ? value[0] : value;
    return (
      forwarded?.split(',')[0]?.trim() ||
      request.ip ||
      request.socket.remoteAddress ||
      'unknown'
    );
  }
}
