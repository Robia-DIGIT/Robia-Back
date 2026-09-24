import type { ExecutionContext } from '@nestjs/common';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { WordPressController } from './wordpress.controller';
import { WordPressService } from './wordpress.service';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

// Prisma silently ignores an `undefined` filter value rather than matching
// nothing — so a raw `@Query('websiteId') websiteId: string` with no
// runtime validation could let a request with no websiteId at all fall
// through to `status`/`disconnect`/`attempts` and operate on whichever
// site/connection Prisma picks first for the organization. These routes
// must reject a missing or empty websiteId before the service ever runs.
describe('WordPressController — websiteId query validation', () => {
  let app: INestApplication<App>;
  const service = {
    status: jest.fn<
      Promise<{ connected: boolean; connection: null }>,
      [string, string]
    >(),
    disconnect: jest.fn<
      Promise<{
        disconnected: boolean;
        localOnly: boolean;
        remoteApplicationPasswordRevoked: boolean;
      }>,
      [string, string]
    >(),
    listAttempts: jest.fn<Promise<unknown[]>, [string, string]>(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service.status.mockResolvedValue({ connected: false, connection: null });
    service.disconnect.mockResolvedValue({
      disconnected: true,
      localOnly: true,
      remoteApplicationPasswordRevoked: false,
    });
    service.listAttempts.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      controllers: [WordPressController],
      providers: [{ provide: WordPressService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OrgScopeGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<ScopedRequest>();
          req.user = { userId: 'user-1', email: 'user@example.com' };
          req.organizationId = 'org-1';
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe.each([
    ['GET', '/integrations/wordpress/status'],
    ['DELETE', '/integrations/wordpress'],
    ['GET', '/integrations/wordpress/attempts'],
  ])('%s %s', (method, path) => {
    const call = (query?: string) =>
      request(app.getHttpServer())[method.toLowerCase() as 'get' | 'delete'](
        query ? `${path}?${query}` : path,
      );

    it('rejects the request when websiteId is missing entirely', async () => {
      await call().expect(400);
      expect(service.status).not.toHaveBeenCalled();
      expect(service.disconnect).not.toHaveBeenCalled();
      expect(service.listAttempts).not.toHaveBeenCalled();
    });

    it('rejects the request when websiteId is an empty string', async () => {
      await call('websiteId=').expect(400);
      expect(service.status).not.toHaveBeenCalled();
      expect(service.disconnect).not.toHaveBeenCalled();
      expect(service.listAttempts).not.toHaveBeenCalled();
    });

    it('accepts a real websiteId and forwards exactly it to the service', async () => {
      await call('websiteId=site-1').expect(200);
      const called: unknown[] | undefined =
        service.status.mock.calls[0] ??
        service.disconnect.mock.calls[0] ??
        service.listAttempts.mock.calls[0];
      expect(called).toEqual(['org-1', 'site-1']);
    });
  });
});
