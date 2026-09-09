import { DocumentsService } from './documents.service';

describe('DocumentsService', () => {
  it('should be defined', () => {
    const service = new DocumentsService({} as never, {} as never);
    expect(service).toBeDefined();
  });
});
