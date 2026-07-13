import { Test, TestingModule } from '@nestjs/testing';
import { ValidationLogsService } from './validation-logs.service';

describe('ValidationLogsService', () => {
  let service: ValidationLogsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ValidationLogsService],
    }).compile();

    service = module.get<ValidationLogsService>(ValidationLogsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
