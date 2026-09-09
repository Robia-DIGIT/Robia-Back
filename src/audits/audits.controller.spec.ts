import { AuditsController } from './audits.controller';

describe('AuditsController', () => {
  it('should be defined', () => {
    const controller = new AuditsController({} as never);
    expect(controller).toBeDefined();
  });
});
