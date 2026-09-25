import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from './request-id.interceptor';
import { REDACTED, redactSensitive } from './redact';

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
 * - formatters.log runs every log object (bindings, custom props, any
 *   application object passed to logger.info/error/...) through
 *   redactSensitive() before it is serialized. This is what protects
 *   application-shaped objects and is the same redactor Sentry runs its
 *   events through (sentry.ts) - see redact.spec.ts for what it catches.
 *
 *   A genuine Node `req`/`res` (an IncomingMessage/ServerResponse instance
 *   - what pino-http itself always attaches) is deliberately excluded from
 *   that walk, and left for pino-http/pino to handle on their own:
 *   - `req` never reaches formatters.log at all - pino-http attaches it
 *     once per request via `logger.child({ req })`, and child bindings are
 *     stringified through pino's own req serializer at that point, a path
 *     formatters.log has no hook into.
 *   - `res` IS part of the per-call merging object, but pino runs
 *     formatters.log BEFORE it applies the res serializer pino-http
 *     registers. redactSensitive() rebuilding `res` (a ServerResponse
 *     instance) into a plain object via Object.entries() strips the
 *     prototype methods (getHeaders, ...) that serializer depends on,
 *     silently breaking statusCode/headers on every log line - so `res`
 *     must reach the serializer untouched too.
 *   In both cases, the actual header values only exist in the object
 *   *after* pino-http's serializers run, which is strictly after
 *   formatters.log - so redactSensitive() could never have reached
 *   req.headers.authorization or res.headers['set-cookie'] regardless.
 *   `redact` below is pino's own fast-redact-based option, which operates
 *   on the fully serialized object at the final JSON-stringify stage -
 *   after both the req/res serializers and formatters.log have run - which
 *   is the only place these headers can be caught.
 *
 *   This exclusion is gated on `instanceof IncomingMessage`/`ServerResponse`,
 *   never on the key name alone: an ORDINARY application object that
 *   happens to be logged under a `req`/`res` key (e.g.
 *   `logger.info({ req: someUpstreamPayload })`) is not a real HTTP
 *   object, carries none of the serializer's prototype dependencies, and
 *   must still go through redactSensitive() like any other application
 *   value - otherwise a `req.body.password` or `res.body.accessToken` in
 *   such a payload would be reinjected verbatim, unprotected by either
 *   redactSensitive() (skipped) or `redact` (whose paths are scoped to the
 *   real HTTP header shape, not arbitrary application payloads).
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
        // Only a genuine Node HTTP req/res is excluded here - see doc
        // comment above. An application object merely named req/res still
        // goes through redactSensitive() like everything else.
        const { req, res, ...rest } = object;
        const redactedRest = redactSensitive(rest) as Record<string, unknown>;
        if (req !== undefined) {
          redactedRest.req =
            req instanceof IncomingMessage ? req : redactSensitive(req);
        }
        if (res !== undefined) {
          redactedRest.res =
            res instanceof ServerResponse ? res : redactSensitive(res);
        }
        return redactedRest;
      },
    },
    // Final-serialization-stage redaction (see doc comment above) for the
    // headers pino-http itself attaches via its req/res serializers.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["proxy-authorization"]',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
    // Health checks and the like would otherwise dominate the log volume.
    autoLogging: {
      ignore: (req: IncomingMessage) => req.url === '/health',
    },
  };
}
