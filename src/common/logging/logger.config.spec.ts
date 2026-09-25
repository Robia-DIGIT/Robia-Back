import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { buildPinoHttpOptions } from './logger.config';

function createCapturingLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = pino(buildPinoHttpOptions(), sink);
  return { logger, getSerialized: () => chunks.join('') };
}

/**
 * This exercises the real pipeline - a real pino-http instance wrapping a
 * real Node http server, a real request with real headers, producing a
 * real serialized JSON log line - because the bug this guards against
 * (formatters.log running before pino-http's own req/res serializers, see
 * logger.config.ts's doc comment) is invisible to a unit test that calls
 * redactSensitive() or reads the static options object directly: both of
 * those would pass even with the `redact` option missing entirely.
 */
describe('buildPinoHttpOptions - real pino-http serialized log line', () => {
  const FAKE_BEARER = 'sk-fake-bearer-abc123xyz';
  const FAKE_COOKIE = 'sid=fake-cookie-value-987';
  const FAKE_PROXY_AUTH = 'Basic fake-proxy-auth-value';
  const FAKE_API_KEY = 'fake-x-api-key-value-456';
  const FAKE_SET_COOKIE = 'session=fake-set-cookie-value-321; Path=/; HttpOnly';
  const FAKE_REQUEST_ID = 'test-request-id-redaction-spec';

  it('redacts every sensitive header in the final JSON line while keeping requestId and other fields', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const middleware = pinoHttp(buildPinoHttpOptions(), sink);

    const server = createServer((req, res) => {
      middleware(req, res);
      res.setHeader('set-cookie', FAKE_SET_COOKIE);
      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/some-route',
          headers: {
            authorization: `Bearer ${FAKE_BEARER}`,
            cookie: FAKE_COOKIE,
            'proxy-authorization': FAKE_PROXY_AUTH,
            'x-api-key': FAKE_API_KEY,
            'x-request-id': FAKE_REQUEST_ID,
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    const serialized = chunks.join('');
    expect(serialized.length).toBeGreaterThan(0);

    for (const secret of [
      FAKE_BEARER,
      FAKE_COOKIE,
      FAKE_PROXY_AUTH,
      FAKE_API_KEY,
      FAKE_SET_COOKIE,
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // Non-sensitive data and the correlation id must survive untouched.
    expect(serialized).toContain(FAKE_REQUEST_ID);
    expect(serialized).toContain('"statusCode":200');

    const lines = serialized
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const responseLine = lines.find(
      (line) => typeof line.res === 'object' && line.res !== null,
    ) as
      | { req?: Record<string, unknown>; res?: Record<string, unknown> }
      | undefined;

    expect(responseLine).toBeDefined();
    const req = responseLine!.req as { headers?: Record<string, unknown> };
    const res = responseLine!.res as { headers?: Record<string, unknown> };

    expect(req.headers?.authorization).toBe('[REDACTED]');
    expect(req.headers?.cookie).toBe('[REDACTED]');
    expect(req.headers?.['proxy-authorization']).toBe('[REDACTED]');
    expect(req.headers?.['x-api-key']).toBe('[REDACTED]');
    expect(res.headers?.['set-cookie']).toBe('[REDACTED]');
    // requestId must survive on the log line itself, not just in raw text.
    expect(req.headers?.['x-request-id']).toBe(FAKE_REQUEST_ID);
  });
});

/**
 * The req/res bypass in formatters.log exists only so a genuine Node
 * IncomingMessage/ServerResponse reaches pino-http's own serializer intact
 * (see logger.config.ts's doc comment). It must not become a blanket
 * "anything named req or res skips redaction" rule: application code can
 * perfectly well log an arbitrary payload under a `req`/`res` key that has
 * nothing to do with pino-http (e.g. forwarding an upstream webhook body).
 * Such a plain object carries none of the real HTTP object's prototype, so
 * it must still go through redactSensitive() like any other application
 * value.
 */
describe('buildPinoHttpOptions - application logs using req/res as ordinary object keys', () => {
  it('redacts req.body.password and req.headers["x-auth-token"] when req is a plain application object, not a real HTTP request', () => {
    const FAKE_PASSWORD = 'app-level-fake-password-abc123';
    const FAKE_AUTH_TOKEN = 'app-level-fake-x-auth-token-xyz789';
    const { logger, getSerialized } = createCapturingLogger();

    logger.info(
      {
        req: {
          body: { password: FAKE_PASSWORD },
          headers: { 'x-auth-token': FAKE_AUTH_TOKEN },
        },
      },
      'application log carrying a plain req-named object',
    );

    const serialized = getSerialized();
    expect(serialized).not.toContain(FAKE_PASSWORD);
    expect(serialized).not.toContain(FAKE_AUTH_TOKEN);

    const parsed = JSON.parse(serialized.trim()) as {
      req: { body: { password: string }; headers: { 'x-auth-token': string } };
    };
    expect(parsed.req.body.password).toBe('[REDACTED]');
    expect(parsed.req.headers['x-auth-token']).toBe('[REDACTED]');
  });

  it('redacts res.body.accessToken when res is a plain application object, not a real HTTP response', () => {
    const FAKE_ACCESS_TOKEN = 'app-level-fake-access-token-def456';
    const { logger, getSerialized } = createCapturingLogger();

    logger.info(
      {
        res: {
          body: { accessToken: FAKE_ACCESS_TOKEN },
        },
      },
      'application log carrying a plain res-named object',
    );

    const serialized = getSerialized();
    expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);

    const parsed = JSON.parse(serialized.trim()) as {
      res: { body: { accessToken: string } };
    };
    expect(parsed.res.body.accessToken).toBe('[REDACTED]');
  });
});
