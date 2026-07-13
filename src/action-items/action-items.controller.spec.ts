import { Test, TestingModule } from '@nestjs/testing';
import { ActionItemsController } from './action-items.controller';

describe('ActionItemsController', () => {
  let controller: ActionItemsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActionItemsController],
    }).compile();

    controller = module.get<ActionItemsController>(ActionItemsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
