import { Test, TestingModule } from '@nestjs/testing';
import { ActionItemsService } from './action-items.service';

describe('ActionItemsService', () => {
  let service: ActionItemsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ActionItemsService],
    }).compile();

    service = module.get<ActionItemsService>(ActionItemsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
