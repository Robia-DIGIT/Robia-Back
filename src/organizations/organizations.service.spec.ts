import { OrganizationsService } from './organizations.service';

describe('OrganizationsService', () => {
  it('should be defined', () => {
    const service = new OrganizationsService({} as never);
    expect(service).toBeDefined();
  });
});
