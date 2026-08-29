import { describe, expect, it, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return the status page', () => {
      expect(appController.getWelcomePage()).toContain('Backend NestJS');
    });

    it('should return the health status', () => {
      expect(appController.getHealth()).toEqual({
        status: 'ok',
        service: 'robia-backend',
      });
    });
  });
});
