// Unit tests for scripts/safe-prisma-migrate.cjs — the mandatory guard in
// front of every `prisma migrate deploy` (see the Dockerfile's `migrate`
// stage and docs/PRISMA_MIGRATION_GUARD.md).
//
// The guard's own real invocation opens genuine `pg` connections; these
// tests instead inject a fake client factory (dependency-injected via
// runMigrationGuard's `createClient` parameter) so every branch — including
// "PostgreSQL is down" and "the two connections land on different servers"
// — is exercised deterministically without a real database. The companion
// deploy/tests/test_prisma_migration_guard.py proves the real-connection
// behavior end-to-end against an actual ephemeral PostgreSQL container.
//
// Loaded via require(), not import: it is a plain .cjs script outside the
// Nest/TS build (the Dockerfile's `migrate` stage runs it directly with
// `node`, with no build step available), so TypeScript has no declarations
// for it — exactly like requiring any other untyped CommonJS module. Typed
// once via the interface below so every call site downstream is checked
// normally, rather than threading `any` through the whole file.

interface ConnectionTarget {
  host: string;
  port: string;
  database: string;
  schema: string;
}

interface FakeIdentity {
  database: string;
  schema: string;
  server_addr: string | null;
  server_port: number | null;
}

interface SpawnResult {
  status: number | null;
}

interface SafePrismaMigrateModule {
  GuardRefusalError: new (message?: string) => Error;
  REFUSAL_EXIT_CODE: number;
  parseConnectionTarget: (
    rawUrl: string | undefined,
    label: string,
  ) => ConnectionTarget;
  targetsEqual: (a: ConnectionTarget, b: ConnectionTarget) => boolean;
  isRestrictedDatabaseName: (name: string) => boolean;
  runMigrationGuard: (options: {
    env: Record<string, string | undefined>;
    createClient: jest.Mock;
    spawnMigrate: jest.Mock;
    log: (message: string) => void;
  }) => Promise<SpawnResult>;
}

function loadGuardModule(): SafePrismaMigrateModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- plain .cjs script with no TS declarations, outside the Nest build.
  const required: unknown = require('../../scripts/safe-prisma-migrate.cjs');
  return required as SafePrismaMigrateModule;
}

const guard = loadGuardModule();

const {
  GuardRefusalError,
  REFUSAL_EXIT_CODE,
  parseConnectionTarget,
  targetsEqual,
  isRestrictedDatabaseName,
  runMigrationGuard,
} = guard;

function makeFakeClient(options: {
  connectFails?: boolean;
  queryFails?: boolean;
  identity?: FakeIdentity;
}) {
  const { connectFails = false, queryFails = false, identity } = options;
  return {
    connect: jest.fn().mockImplementation(() => {
      if (connectFails) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve();
    }),
    query: jest.fn().mockImplementation(() => {
      if (queryFails) return Promise.reject(new Error('query failed'));
      return Promise.resolve({ rows: [identity] });
    }),
    end: jest.fn().mockResolvedValue(undefined),
  };
}

const PROD_URL = 'postgresql://appuser:s3cr3t@db:5432/postgres?schema=public';
const QA_URL = 'postgresql://appuser:s3cr3t@qa-db:5432/robia_qa?schema=public';
const STAGING_URL =
  'postgresql://appuser:s3cr3t@staging-db:5432/robia_staging?schema=public';

const PROD_IDENTITY: FakeIdentity = {
  database: 'postgres',
  schema: 'public',
  server_addr: '10.0.0.5',
  server_port: 5432,
};
const STAGING_IDENTITY: FakeIdentity = {
  database: 'robia_staging',
  schema: 'public',
  server_addr: '10.0.0.9',
  server_port: 5432,
};

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: PROD_URL,
    DIRECT_URL: PROD_URL,
    EXPECTED_DATABASE_HOST: 'db',
    EXPECTED_DATABASE_NAME: 'postgres',
    MIGRATION_ENVIRONMENT: 'production',
    ...overrides,
  };
}

describe('parseConnectionTarget', () => {
  it('extracts host/port/database/schema without ever returning credentials', () => {
    const target = parseConnectionTarget(PROD_URL, 'DATABASE_URL');
    expect(target).toEqual({
      host: 'db',
      port: '5432',
      database: 'postgres',
      schema: 'public',
    });
    expect(Object.values(target)).not.toContain('appuser');
    expect(Object.values(target)).not.toContain('s3cr3t');
  });

  it('defaults the schema to public when absent', () => {
    const target = parseConnectionTarget(
      'postgresql://user:pass@host:5432/db',
      'DATABASE_URL',
    );
    expect(target.schema).toBe('public');
  });

  it('refuses a missing URL without leaking anything about it', () => {
    expect(() => parseConnectionTarget(undefined, 'DATABASE_URL')).toThrow(
      GuardRefusalError,
    );
  });

  it('refuses a malformed URL', () => {
    expect(() => parseConnectionTarget('not-a-url', 'DIRECT_URL')).toThrow(
      GuardRefusalError,
    );
  });
});

describe('targetsEqual / isRestrictedDatabaseName', () => {
  it('treats two identical targets as equal', () => {
    const a = parseConnectionTarget(PROD_URL, 'DATABASE_URL');
    const b = parseConnectionTarget(PROD_URL, 'DIRECT_URL');
    expect(targetsEqual(a, b)).toBe(true);
  });

  it('treats a different host as unequal', () => {
    const a = parseConnectionTarget(PROD_URL, 'DATABASE_URL');
    const b = parseConnectionTarget(QA_URL, 'DIRECT_URL');
    expect(targetsEqual(a, b)).toBe(false);
  });

  it.each(['postgres', 'template0', 'template1'])(
    'flags %s as a restricted database name',
    (name) => {
      expect(isRestrictedDatabaseName(name)).toBe(true);
    },
  );

  it('does not flag an ordinary database name', () => {
    expect(isRestrictedDatabaseName('robia_staging')).toBe(false);
  });
});

describe('runMigrationGuard', () => {
  it('launches prisma migrate deploy when both URLs agree and the real target matches', async () => {
    const client = makeFakeClient({ identity: PROD_IDENTITY });
    const createClient = jest.fn().mockReturnValue(client);
    const spawnMigrate = jest.fn().mockReturnValue({ status: 0 });

    const result = await runMigrationGuard({
      env: baseEnv(),
      createClient,
      spawnMigrate,
      log: jest.fn(),
    });

    expect(spawnMigrate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 0 });
    expect(client.end).toHaveBeenCalledTimes(2);
  });

  it('refuses before opening any connection when DATABASE_URL and DIRECT_URL diverge', async () => {
    const createClient = jest.fn();
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv({ DIRECT_URL: QA_URL }),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(createClient).not.toHaveBeenCalled();
    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses when DIRECT_URL targets production but DATABASE_URL targets QA', async () => {
    const createClient = jest.fn();
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv({ DATABASE_URL: QA_URL, DIRECT_URL: PROD_URL }),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(createClient).not.toHaveBeenCalled();
    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses on a differing host even when database/schema otherwise match', async () => {
    const createClient = jest.fn();
    const spawnMigrate = jest.fn();
    const otherHostSameDb =
      'postgresql://u:p@other-host:5432/postgres?schema=public';

    await expect(
      runMigrationGuard({
        env: baseEnv({ DIRECT_URL: otherHostSameDb }),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses on a differing database name even when the host matches', async () => {
    const createClient = jest.fn();
    const spawnMigrate = jest.fn();
    const sameHostOtherDb = 'postgresql://u:p@db:5432/other_db?schema=public';

    await expect(
      runMigrationGuard({
        env: baseEnv({ DIRECT_URL: sameHostOtherDb }),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses when the real current_database() differs from what was declared', async () => {
    const client = makeFakeClient({
      identity: { ...PROD_IDENTITY, database: 'some_other_db' },
    });
    const createClient = jest.fn().mockReturnValue(client);
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv(),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses when the two live connections report different real servers', async () => {
    let call = 0;
    const createClient = jest.fn().mockImplementation(() => {
      call += 1;
      // Same declared host/database/schema, but the two live connections
      // resolve to two different physical servers — exactly the scenario a
      // stale DNS entry or a load-balanced hostname could produce.
      return makeFakeClient({
        identity: {
          ...PROD_IDENTITY,
          server_addr: call === 1 ? '10.0.0.5' : '10.0.0.6',
        },
      });
    });
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv(),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses "postgres" as a target outside an explicit production environment (staging posture)', async () => {
    const createClient = jest.fn();
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv({ MIGRATION_ENVIRONMENT: undefined }),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(createClient).not.toHaveBeenCalled();
    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('permits "postgres" as a target only with MIGRATION_ENVIRONMENT=production explicitly set', async () => {
    const client = makeFakeClient({ identity: PROD_IDENTITY });
    const createClient = jest.fn().mockReturnValue(client);
    const spawnMigrate = jest.fn().mockReturnValue({ status: 0 });

    await runMigrationGuard({
      env: baseEnv({ MIGRATION_ENVIRONMENT: 'production' }),
      createClient,
      spawnMigrate,
      log: jest.fn(),
    });

    expect(spawnMigrate).toHaveBeenCalledTimes(1);
  });

  it('never restricts an ordinary staging database name', async () => {
    const client = makeFakeClient({ identity: STAGING_IDENTITY });
    const createClient = jest.fn().mockReturnValue(client);
    const spawnMigrate = jest.fn().mockReturnValue({ status: 0 });

    await runMigrationGuard({
      env: {
        DATABASE_URL: STAGING_URL,
        DIRECT_URL: STAGING_URL,
        EXPECTED_DATABASE_HOST: 'staging-db',
        EXPECTED_DATABASE_NAME: 'robia_staging',
      },
      createClient,
      spawnMigrate,
      log: jest.fn(),
    });

    expect(spawnMigrate).toHaveBeenCalledTimes(1);
  });

  it.each(['EXPECTED_DATABASE_HOST', 'EXPECTED_DATABASE_NAME'])(
    'refuses when %s is absent, before touching the network',
    async (missingVar) => {
      const createClient = jest.fn();
      const spawnMigrate = jest.fn();

      await expect(
        runMigrationGuard({
          env: baseEnv({ [missingVar]: undefined }),
          createClient,
          spawnMigrate,
          log: jest.fn(),
        }),
      ).rejects.toBeInstanceOf(GuardRefusalError);

      expect(createClient).not.toHaveBeenCalled();
      expect(spawnMigrate).not.toHaveBeenCalled();
    },
  );

  it('refuses when PostgreSQL itself is unreachable, and never runs Prisma', async () => {
    const createClient = jest
      .fn()
      .mockReturnValue(makeFakeClient({ connectFails: true }));
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv(),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('refuses when the identity query itself fails, and never runs Prisma', async () => {
    const createClient = jest
      .fn()
      .mockReturnValue(
        makeFakeClient({ queryFails: true, identity: PROD_IDENTITY }),
      );
    const spawnMigrate = jest.fn();

    await expect(
      runMigrationGuard({
        env: baseEnv(),
        createClient,
        spawnMigrate,
        log: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(GuardRefusalError);

    expect(spawnMigrate).not.toHaveBeenCalled();
  });

  it('never logs a full connection string, username, or password on any path, success or refusal', async () => {
    const messages: string[] = [];
    const log = (message: string) => messages.push(message);
    const secretUser = 'appuser';
    const secretPassword = 's3cr3t';

    // Success path.
    await runMigrationGuard({
      env: baseEnv(),
      createClient: () => makeFakeClient({ identity: PROD_IDENTITY }),
      spawnMigrate: () => ({ status: 0 }),
      log,
    });

    // A representative sample of refusal paths.
    const refusalScenarios: Array<Record<string, string | undefined>> = [
      baseEnv({ DIRECT_URL: QA_URL }),
      baseEnv({ MIGRATION_ENVIRONMENT: undefined }),
      baseEnv({ EXPECTED_DATABASE_HOST: undefined }),
    ];
    for (const env of refusalScenarios) {
      try {
        await runMigrationGuard({
          env,
          createClient: () => makeFakeClient({ identity: PROD_IDENTITY }),
          spawnMigrate: () => ({ status: 0 }),
          log,
        });
      } catch (error) {
        if (error instanceof GuardRefusalError) messages.push(error.message);
        else throw error;
      }
    }

    const combined = messages.join('\n');
    expect(combined).not.toContain(secretUser);
    expect(combined).not.toContain(secretPassword);
    expect(combined.toLowerCase()).not.toMatch(/postgres(ql)?:\/\/\S*:\S*@/);
  });
});

describe('exit code', () => {
  it('exposes a refusal exit code distinct from success (0) and a generic failure (1)', () => {
    expect(REFUSAL_EXIT_CODE).toBe(42);
    expect(REFUSAL_EXIT_CODE).not.toBe(0);
    expect(REFUSAL_EXIT_CODE).not.toBe(1);
  });
});
