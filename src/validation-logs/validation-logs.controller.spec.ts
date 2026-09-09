import { ValidationLogsController } from './validation-logs.controller';

describe('ValidationLogsController', () => {
  it('should be defined', () => {
    const controller = new ValidationLogsController({} as never);
    expect(controller).toBeDefined();
  });
});
