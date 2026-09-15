import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

@Controller('throttle-test')
class ThrottleTestController {
  @Get()
  get(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 2 }],
    }),
  ],
  controllers: [ThrottleTestController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
class ThrottleTestModule {}

describe('Throttler behind a trusted reverse proxy', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleTestModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps separate counters for clients forwarded by Caddy', async () => {
    const server = app.getHttpServer();

    await request(server)
      .get('/throttle-test')
      .set('X-Forwarded-For', '198.51.100.10')
      .expect(200);
    await request(server)
      .get('/throttle-test')
      .set('X-Forwarded-For', '198.51.100.10')
      .expect(200);

    await request(server)
      .get('/throttle-test')
      .set('X-Forwarded-For', '198.51.100.11')
      .expect(200);

    await request(server)
      .get('/throttle-test')
      .set('X-Forwarded-For', '198.51.100.10')
      .expect(429);
  });
});
