import { ActionItemsController } from './action-items.controller';

describe('ActionItemsController', () => {
  it('should be defined', () => {
    const controller = new ActionItemsController(
      {} as never,
      {} as never,
      {} as never,
    );
    expect(controller).toBeDefined();
  });
});
