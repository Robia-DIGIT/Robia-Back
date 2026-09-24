'use strict';

// Prisma migration guard, inspired by the validated staging VPS runbook.
//
// Why this exists: prisma.config.ts's `migrations` datasource uses only
// DIRECT_URL, while the running application uses only DATABASE_URL — two
// independently-configured env vars that are never cross-checked by Prisma
// itself. A prior incident had DATABASE_URL pointing at QA while DIRECT_URL
// pointed at production: nothing in the deploy pipeline noticed, and a
// migration ran against production while the app kept talking to QA. This
// script is the mandatory gate in front of every `prisma migrate deploy`
// (see the Dockerfile's `migrate` stage) that makes that class of incident
// structurally impossible: it never trusts the connection strings alone —
// it opens both connections for real and cross-checks what the PostgreSQL
// server itself reports.
//
// Security invariant, enforced throughout this file: never log a full
// connection string, a username, or a password. Host, port, database name
// and schema are not secrets and are logged freely for operability.
//
// `require.main === module` guards the CLI entry point so every exported
// function below can be unit-tested in isolation (with an injected fake
// `pg` client) without ever opening a real connection or invoking Prisma.

const { Client } = require('pg');
const { spawnSync } = require('node:child_process');

const REFUSAL_EXIT_CODE = 42;

// Neither opening a connection nor running the identity query may hang
// indefinitely — an unreachable PostgreSQL server (a firewalled host, a
// server that never replies) must fail cleanly and promptly, not leave the
// deploy pipeline stuck forever. connectionTimeoutMillis bounds
// client.connect(); query_timeout bounds each query on an already-open
// connection; statement_timeout is the same bound enforced server-side, as
// defense in depth if the client-side timer is ever bypassed. Whatever the
// underlying `pg` error says on a timeout, it is never surfaced directly —
// every catch block below substitutes its own redacted message.
const CONNECTION_TIMEOUT_MS = 10_000;

// The production database is genuinely named "postgres" today (see
// docs/PRISMA_MIGRATION_GUARD.md) — a name PostgreSQL also uses for its own
// template/administrative databases. Running a real applicative migration
// against one of these names must never happen by accident (a misconfigured
// staging URL that happens to omit a database path, for instance), so it is
// refused unless the operator has explicitly declared this run as
// production via MIGRATION_ENVIRONMENT.
const RESTRICTED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);

class GuardRefusalError extends Error {}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

// Parses a postgres(ql):// connection string into its logical target
// (host/port/database/schema) only — the returned object never carries the
// username or password, and the raw string is never echoed back in any
// error this function throws.
function parseConnectionTarget(rawUrl, label) {
  if (isBlank(rawUrl)) {
    throw new GuardRefusalError(`${label} est absente ou vide.`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GuardRefusalError(`${label} n'est pas une URL PostgreSQL valide.`);
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new GuardRefusalError(`${label} doit utiliser le protocole postgres:// ou postgresql://.`);
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const schema = parsed.searchParams.get('schema') || 'public';
  if (isBlank(host) || isBlank(database)) {
    throw new GuardRefusalError(`${label} est incomplète (hôte ou nom de base manquant).`);
  }
  return { host, port, database, schema };
}

function describeTarget(target) {
  return `host=${target.host} port=${target.port} database=${target.database} schema=${target.schema}`;
}

function targetsEqual(a, b) {
  return a.host === b.host && a.port === b.port && a.database === b.database && a.schema === b.schema;
}

function isRestrictedDatabaseName(name) {
  return RESTRICTED_DATABASE_NAMES.has(name);
}

// Reads back what the PostgreSQL server itself believes it is — never
// trusted from the connection string alone. inet_server_addr()/
// inet_server_port() are what actually prove two connections landed on the
// same physical server, independent of what hostname each one was told to
// dial (DNS, /etc/hosts, or a load balancer could otherwise make two
// different-looking targets resolve to the same place, or vice versa).
async function queryServerIdentity(client) {
  const result = await client.query(
    'select current_database() as database, current_schema() as schema, ' +
      'inet_server_addr() as server_addr, inet_server_port() as server_port',
  );
  return result.rows[0];
}

/**
 * Runs every safety check and, only if all of them pass, launches
 * `prisma migrate deploy`. Throws GuardRefusalError (never logging a URL,
 * username or password) on any refusal — the caller decides what to do
 * with that (main() below turns it into REFUSAL_EXIT_CODE).
 *
 * `createClient` and `spawnMigrate` are injected so tests can exercise the
 * full decision logic against a fake PostgreSQL server and a fake Prisma
 * invocation, without a real database or a real `npx prisma` process.
 */
async function runMigrationGuard({
  env = process.env,
  createClient = (connectionString) =>
    new Client({
      connectionString,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      query_timeout: CONNECTION_TIMEOUT_MS,
      statement_timeout: CONNECTION_TIMEOUT_MS,
    }),
  spawnMigrate = () =>
    spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', env }),
  log = (message) => console.log(`[safe-prisma-migrate] ${message}`),
} = {}) {
  const expectedHost = env.EXPECTED_DATABASE_HOST;
  const expectedDatabase = env.EXPECTED_DATABASE_NAME;
  if (isBlank(expectedHost)) {
    throw new GuardRefusalError('EXPECTED_DATABASE_HOST est absente ou vide.');
  }
  if (isBlank(expectedDatabase)) {
    throw new GuardRefusalError('EXPECTED_DATABASE_NAME est absente ou vide.');
  }

  // Step 1 — parse-and-compare only, no connection opened yet: a divergence
  // here is refused immediately, before anything ever touches the network.
  const runtimeTarget = parseConnectionTarget(env.DATABASE_URL, 'DATABASE_URL');
  const migrationTarget = parseConnectionTarget(env.DIRECT_URL, 'DIRECT_URL');

  log(`cible runtime déclarée (DATABASE_URL) : ${describeTarget(runtimeTarget)}`);
  log(`cible migration déclarée (DIRECT_URL) : ${describeTarget(migrationTarget)}`);

  if (!targetsEqual(runtimeTarget, migrationTarget)) {
    throw new GuardRefusalError(
      `DATABASE_URL et DIRECT_URL ne ciblent pas la même base : ` +
        `${describeTarget(runtimeTarget)} vs ${describeTarget(migrationTarget)}.`,
    );
  }

  // Step 2 — both URLs agree with each other, but do they agree on the
  // RIGHT target? Catches the case where both were consistently
  // misconfigured to point at the same wrong environment.
  if (migrationTarget.host !== expectedHost.toLowerCase() || migrationTarget.database !== expectedDatabase) {
    throw new GuardRefusalError(
      `La cible déclarée (${describeTarget(migrationTarget)}) ne correspond pas à la cible ` +
        `attendue (host=${expectedHost} database=${expectedDatabase}).`,
    );
  }

  // Step 3 — the postgres/template0/template1 gate, decided purely from the
  // declared target so it is refused before ever opening a connection.
  const migrationEnvironment = env.MIGRATION_ENVIRONMENT;
  if (isRestrictedDatabaseName(migrationTarget.database) && migrationEnvironment !== 'production') {
    throw new GuardRefusalError(
      `La base "${migrationTarget.database}" est réservée à l'environnement production ` +
        `explicite (définir MIGRATION_ENVIRONMENT=production pour l'autoriser).`,
    );
  }

  // Step 4 — the declarations line up; now prove it for real by opening
  // both connections and asking the server itself.
  const runtimeClient = createClient(env.DATABASE_URL);
  const migrationClient = createClient(env.DIRECT_URL);
  let runtimeIdentity;
  let migrationIdentity;
  try {
    try {
      await runtimeClient.connect();
    } catch {
      throw new GuardRefusalError('Connexion à la base runtime (DATABASE_URL) impossible.');
    }
    try {
      await migrationClient.connect();
    } catch {
      throw new GuardRefusalError('Connexion à la base migration (DIRECT_URL) impossible.');
    }

    try {
      runtimeIdentity = await queryServerIdentity(runtimeClient);
      migrationIdentity = await queryServerIdentity(migrationClient);
    } catch {
      throw new GuardRefusalError(
        "La vérification d'identité du serveur PostgreSQL a échoué sur l'une des deux connexions.",
      );
    }
  } finally {
    await Promise.allSettled([runtimeClient.end(), migrationClient.end()]);
  }

  log(
    `identité réelle runtime : database=${runtimeIdentity.database} schema=${runtimeIdentity.schema} ` +
      `server=${runtimeIdentity.server_addr}:${runtimeIdentity.server_port}`,
  );
  log(
    `identité réelle migration : database=${migrationIdentity.database} schema=${migrationIdentity.schema} ` +
      `server=${migrationIdentity.server_addr}:${migrationIdentity.server_port}`,
  );

  if (runtimeIdentity.database !== expectedDatabase || migrationIdentity.database !== expectedDatabase) {
    throw new GuardRefusalError(
      `current_database() réel (${runtimeIdentity.database} / ${migrationIdentity.database}) ne ` +
        `correspond pas à la base attendue (${expectedDatabase}).`,
    );
  }
  if (runtimeIdentity.schema !== migrationTarget.schema || migrationIdentity.schema !== migrationTarget.schema) {
    throw new GuardRefusalError(
      `current_schema() réel ne correspond pas au schéma déclaré (${migrationTarget.schema}).`,
    );
  }

  // The decisive check: two connections that both *claim* the same
  // host/port/database can still land on two different physical servers
  // (a stale DNS entry, a load-balanced hostname, a hosts-file override).
  // Only a matching inet_server_addr()/inet_server_port() pair, read back
  // from each live connection, actually proves they are the same server.
  if (!runtimeIdentity.server_addr || !runtimeIdentity.server_port) {
    throw new GuardRefusalError(
      "Impossible de déterminer l'adresse réelle du serveur PostgreSQL (inet_server_addr() vide).",
    );
  }
  const runtimeServer = `${runtimeIdentity.server_addr}:${runtimeIdentity.server_port}`;
  const migrationServer = `${migrationIdentity.server_addr}:${migrationIdentity.server_port}`;
  if (runtimeServer !== migrationServer) {
    throw new GuardRefusalError(
      'Les connexions runtime et migration n\'aboutissent pas au même serveur PostgreSQL réel.',
    );
  }

  log('tous les contrôles ont réussi — lancement de "prisma migrate deploy".');
  return spawnMigrate();
}

async function main() {
  let result;
  try {
    result = await runMigrationGuard();
  } catch (error) {
    const reason =
      error instanceof GuardRefusalError
        ? error.message
        : "erreur inattendue lors des contrôles de sécurité (voir les logs de l'application appelante).";
    console.error(`[safe-prisma-migrate] REFUS : ${reason}`);
    process.exitCode = REFUSAL_EXIT_CODE;
    return;
  }
  process.exitCode = typeof result?.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  REFUSAL_EXIT_CODE,
  RESTRICTED_DATABASE_NAMES,
  GuardRefusalError,
  parseConnectionTarget,
  describeTarget,
  targetsEqual,
  isRestrictedDatabaseName,
  queryServerIdentity,
  runMigrationGuard,
};
