import { Test, TestingModule } from '@nestjs/testing';
import { AuditsController } from './audits.controller';

describe('AuditsController', () => {
  let controller: AuditsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditsController],
    }).compile();

    controller = module.get<AuditsController>(AuditsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
