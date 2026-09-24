// Proves the guard's DEFAULT `createClient` factory — the one actually used
// when the CLI entry point (main(), guarded by `require.main === module`)
// runs for real, as opposed to every test in safe-prisma-migrate.spec.ts,
// which injects its own fake `createClient` and therefore never exercises
// this wiring — bounds every real `pg` connection and query to 10 seconds.
// Without this, an unreachable/unresponsive PostgreSQL server would hang
// the deploy pipeline indefinitely instead of failing cleanly (see
// deploy/tests/test_prisma_migration_guard.py for the real-network,
// real-timing proof against an actual unreachable host).
//
// `pg` itself is mocked so this stays a fast, deterministic unit test with
// no real network I/O — only the options passed to `new Client(...)` are
// inspected.

jest.mock('pg', () => {
  const connect = jest.fn().mockResolvedValue(undefined);
  const query = jest.fn().mockResolvedValue({
    rows: [
      {
        database: 'postgres',
        schema: 'public',
        server_addr: '10.0.0.5',
        server_port: 5432,
      },
    ],
  });
  const end = jest.fn().mockResolvedValue(undefined);
  const Client = jest.fn().mockImplementation(() => ({ connect, query, end }));
  return { Client };
});

import { Client } from 'pg';

interface SafePrismaMigrateModule {
  runMigrationGuard: (options: {
    env: Record<string, string | undefined>;
    spawnMigrate: () => { status: number | null };
    log: (message: string) => void;
  }) => Promise<{ status: number | null }>;
}

function loadGuardModule(): SafePrismaMigrateModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- plain .cjs script with no TS declarations, outside the Nest build.
  const required: unknown = require('../../scripts/safe-prisma-migrate.cjs');
  return required as SafePrismaMigrateModule;
}

const { runMigrationGuard } = loadGuardModule();

const PROD_URL = 'postgresql://appuser:s3cr3t@db:5432/postgres?schema=public';

describe('runMigrationGuard default createClient (real pg wiring)', () => {
  it('constructs every pg.Client with a bounded 10-second connection, query and statement timeout', async () => {
    await runMigrationGuard({
      env: {
        DATABASE_URL: PROD_URL,
        DIRECT_URL: PROD_URL,
        EXPECTED_DATABASE_HOST: 'db',
        EXPECTED_DATABASE_NAME: 'postgres',
        MIGRATION_ENVIRONMENT: 'production',
      },
      spawnMigrate: () => ({ status: 0 }),
      log: jest.fn(),
    });

    const mockedClient = Client as unknown as jest.Mock<
      unknown,
      [Record<string, unknown>]
    >;
    expect(mockedClient).toHaveBeenCalledTimes(2);
    for (const [options] of mockedClient.mock.calls) {
      expect(options).toMatchObject({
        connectionTimeoutMillis: 10_000,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
    }
  });
});
