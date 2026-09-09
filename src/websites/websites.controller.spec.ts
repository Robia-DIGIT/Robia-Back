import { WebsitesController } from './websites.controller';

describe('WebsitesController', () => {
  it('should be defined', () => {
    const controller = new WebsitesController({} as never);
    expect(controller).toBeDefined();
  });
});
