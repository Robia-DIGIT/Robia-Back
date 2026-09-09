import { AuthController } from './auth.controller';

describe('AuthController', () => {
  it('should be defined', () => {
    const controller = new AuthController({} as never);
    expect(controller).toBeDefined();
  });
});
