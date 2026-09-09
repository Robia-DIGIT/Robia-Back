import { OrganizationsController } from './organizations.controller';

describe('OrganizationsController', () => {
  it('should be defined', () => {
    const controller = new OrganizationsController({} as never);
    expect(controller).toBeDefined();
  });
});
