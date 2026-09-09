import { OpportunitiesController } from './opportunities.controller';

describe('OpportunitiesController', () => {
  it('should be defined', () => {
    const controller = new OpportunitiesController({} as never);
    expect(controller).toBeDefined();
  });
});
