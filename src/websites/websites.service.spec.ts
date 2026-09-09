import { WebsitesService } from './websites.service';

describe('WebsitesService', () => {
  it('should be defined', () => {
    const service = new WebsitesService({} as never);
    expect(service).toBeDefined();
  });
});
