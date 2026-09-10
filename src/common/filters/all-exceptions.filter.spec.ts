import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let response: Pick<Response, 'headersSent' | 'status' | 'json'>;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    host = {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves safe client validation details and the HTTP status', () => {
    filter.catch(
      new BadRequestException({
        statusCode: 400,
        message: ['email must be an email'],
        error: 'Bad Request',
      }),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: ['email must be an email'],
      error: 'Bad Request',
    });
  });

  it('hides the message of an HTTP 5xx exception', () => {
    filter.catch(
      new HttpException(
        'postgresql://internal-host:5432 secret detail',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 503,
      message: 'Une erreur interne est survenue.',
    });
  });

  it('hides an unexpected error and logs it internally', () => {
    const error = new Error('sensitive stack detail');

    filter.catch(error, host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Une erreur interne est survenue.',
    });
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      error.message,
      error.stack,
    );
  });

  it('does not write a second response after headers were sent', () => {
    response.headersSent = true;

    filter.catch(new Error('late failure'), host);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });
});
