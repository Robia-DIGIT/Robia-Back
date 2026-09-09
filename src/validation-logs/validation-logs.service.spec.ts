import { ValidationLogsService } from './validation-logs.service';

describe('ValidationLogsService', () => {
  it('should be defined', () => {
    const service = new ValidationLogsService({} as never);
    expect(service).toBeDefined();
  });
});
