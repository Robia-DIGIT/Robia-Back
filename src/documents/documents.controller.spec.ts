import { DocumentsController } from './documents.controller';

describe('DocumentsController', () => {
  it('should be defined', () => {
    const controller = new DocumentsController({} as never);
    expect(controller).toBeDefined();
  });
});
