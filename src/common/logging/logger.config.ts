import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { REQUEST_ID_HEADER } from './request-id.interceptor';
import { redactSensitive } from './redact';

interface RequestWithContext extends IncomingMessage {
  user?: { userId?: string };
  organizationId?: string;
}

/**
 * Structured JSON logging (RC-15). One config, used by LoggerModule in
 * app.module.ts.
 *
 * - genReqId reuses an id forwarded by an upstream caller (Caddy, the
 *   dashboard, python-service on a callback) when present, generating a
 *   fresh UUID otherwise. This becomes `req.id`; RequestIdInterceptor
 *   reads that same value to echo it back as X-Request-Id — one id, one
 *   correlation key, from request in to response out. Deliberately not
 *   done in Express middleware: middleware registration order between
 *   nestjs-pino's own middleware and anything this module adds is not
 *   guaranteed, whereas a Nest interceptor always runs after all
 *   middleware, so it can rely on req.id already being set.
 * - customProps attaches organizationId/userId when the request has
 *   reached a point where they're known (set by OrgScopeGuard /
 *   Passport respectively) — absent on public routes, present on
 *   authenticated + org-scoped ones.
 * - formatters.log runs every log object (bindings, custom props, the
 *   req/res pino-http attaches) through redactSensitive() before it is
 *   serialized. This is the actual redaction guarantee - see
 *   redact.spec.ts for what it catches.
 */
export function buildPinoHttpOptions() {
  return {
    level: process.env.LOG_LEVEL || 'info',
    genReqId: (req: IncomingMessage): string => {
      const header = req.headers[REQUEST_ID_HEADER];
      const incoming = Array.isArray(header) ? header[0] : header;
      return incoming && incoming.trim().length > 0
        ? incoming.trim()
        : randomUUID();
    },
    customProps: (req: IncomingMessage) => {
      const request = req as RequestWithContext;
      return {
        organizationId: request.organizationId,
        userId: request.user?.userId,
      };
    },
    formatters: {
      log(object: Record<string, unknown>) {
        return redactSensitive(object) as Record<string, unknown>;
      },
    },
    // Health checks and the like would otherwise dominate the log volume.
    autoLogging: {
      ignore: (req: IncomingMessage) => req.url === '/health',
    },
  };
}
