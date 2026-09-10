import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

const INTERNAL_ERROR_MESSAGE = 'Une erreur interne est survenue.';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      return;
    }

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!isHttpException || status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      response.status(status).json({
        statusCode: status,
        message: INTERNAL_ERROR_MESSAGE,
      });
      return;
    }

    const payload = isHttpException
      ? exception.getResponse()
      : INTERNAL_ERROR_MESSAGE;
    const body =
      typeof payload === 'string'
        ? { statusCode: status, message: payload }
        : { ...payload, statusCode: status };

    response.status(status).json(body);
  }
}
