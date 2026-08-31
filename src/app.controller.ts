import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header('Content-Type', 'text/html')
  getWelcomePage() {
    return this.appService.getBeautifulPage();
  }

  @Get('health')
  getHealth() {
    return { status: 'ok', service: 'robia-backend' };
  }
}
