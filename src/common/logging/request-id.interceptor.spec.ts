import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { RequestIdInterceptor } from './request-id.interceptor';

function context(request: { id?: string }, response: { setHeader: jest.Mock }) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function handler(): CallHandler {
  return { handle: () => of('result') };
}

describe('RequestIdInterceptor', () => {
  const interceptor = new RequestIdInterceptor();

  it('echoes req.id back as the X-Request-Id response header', (done) => {
    const response = { setHeader: jest.fn() };

    interceptor
      .intercept(context({ id: 'abc-123' }, response), handler())
      .subscribe(() => {
        expect(response.setHeader).toHaveBeenCalledWith(
          'X-Request-Id',
          'abc-123',
        );
        done();
      });
  });

  it('does nothing when req.id is not set, without throwing', (done) => {
    const response = { setHeader: jest.fn() };

    interceptor.intercept(context({}, response), handler()).subscribe(() => {
      expect(response.setHeader).not.toHaveBeenCalled();
      done();
    });
  });

  it('always forwards the handler result unchanged', (done) => {
    const response = { setHeader: jest.fn() };

    interceptor
      .intercept(context({ id: 'x' }, response), handler())
      .subscribe((value) => {
        expect(value).toBe('result');
        done();
      });
  });
});
