import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Echoes the request id pino-http assigned (see logger.config.ts's
 * genReqId) back on the response as X-Request-Id, so a client can
 * correlate its own logs/support requests with ours.
 *
 * An interceptor rather than middleware on purpose: interceptors always
 * run after every global middleware in Nest's pipeline, so `req.id` -
 * set by pino-http's middleware - is guaranteed to already be there.
 * Middleware registration order between two modules is not guaranteed
 * the same way.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ id?: string }>();
    const response = http.getResponse<Response>();

    if (request?.id) {
      response.setHeader('X-Request-Id', request.id);
    }

    return next.handle();
  }
}
