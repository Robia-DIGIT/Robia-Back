import { Test, TestingModule } from '@nestjs/testing';
import { ValidationLogsController } from './validation-logs.controller';

describe('ValidationLogsController', () => {
  let controller: ValidationLogsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ValidationLogsController],
    }).compile();

    controller = module.get<ValidationLogsController>(ValidationLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
