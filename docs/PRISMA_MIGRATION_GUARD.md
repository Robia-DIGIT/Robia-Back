# hardening/prisma-migration-guard — garde-fou Prisma obligatoire

## Pourquoi ce garde-fou existe

`prisma.config.ts` et l'application runtime utilisent deux variables
d'environnement **distinctes**, jamais recoupées par Prisma lui-même :

```ts
// prisma.config.ts
export default defineConfig({
  // ...
  datasource: {
    url: process.env["DIRECT_URL"], // ← utilisée UNIQUEMENT pour les migrations
  },
});
```

- **`DATABASE_URL`** — utilisée par l'application NestJS en fonctionnement
  normal (le pool de connexions runtime).
- **`DIRECT_URL`** — utilisée **uniquement** par `prisma migrate deploy`
  (voir `prisma.config.ts` ci-dessus), typiquement une connexion directe
  (non poolée) au même serveur.

Rien dans Prisma ne vérifie que ces deux variables pointent réellement vers
la même base. Un incident antérieur a eu lieu exactement à cause de cela :
`DATABASE_URL` ciblait la base QA pendant que `DIRECT_URL` ciblait la
production — une migration a donc été appliquée en production alors que
l'application continuait de parler à QA, sans qu'aucune étape du pipeline
de déploiement ne le détecte.

`scripts/safe-prisma-migrate.cjs` est le garde-fou obligatoire placé devant
`prisma migrate deploy` (voir l'étage `migrate` du `Dockerfile`) qui rend
cette classe d'incident structurellement impossible.

## Ce que le garde-fou vérifie, dans l'ordre

1. **Présence des variables** — `DATABASE_URL`, `DIRECT_URL`,
   `EXPECTED_DATABASE_HOST`, `EXPECTED_DATABASE_NAME` doivent toutes être
   définies. Absence de l'une d'entre elles → refus immédiat, avant tout
   accès réseau.
2. **Cohérence déclarée** — `DATABASE_URL` et `DIRECT_URL` doivent parser
   vers la **même cible logique** : hôte, port, base de données, schéma.
   Une divergence est refusée avant même d'ouvrir une connexion.
3. **Cible attendue** — la cible déclarée par `DIRECT_URL` doit correspondre
   exactement à `EXPECTED_DATABASE_HOST`/`EXPECTED_DATABASE_NAME`. Ceci
   attrape le cas où `DATABASE_URL` et `DIRECT_URL` sont cohérentes entre
   elles mais pointent, ensemble, vers le mauvais environnement.
4. **Bases réservées** — `postgres`, `template0` et `template1` (des noms
   génériques que PostgreSQL utilise aussi pour ses propres bases
   techniques) sont refusées, sauf si `MIGRATION_ENVIRONMENT=production`
   est défini explicitement. La production actuelle est réellement nommée
   `postgres` (voir ci-dessous) ; cette variable en est la preuve explicite,
   jamais déduite implicitement.
5. **Connexions réelles** — le garde-fou ouvre ensuite **deux vraies
   connexions PostgreSQL** (via `pg`), une pour chaque URL. Une panne de
   connexion (PostgreSQL indisponible, identifiants invalides, etc.) est
   refusée.
6. **Identité réelle du serveur** — sur chaque connexion, le garde-fou lit
   `current_database()`, `current_schema()`, `inet_server_addr()` et
   `inet_server_port()` :
   - `current_database()`/`current_schema()` doivent correspondre à ce qui
     était déclaré (protège contre un `search_path` ou un proxy qui
     redirigerait silencieusement la connexion).
   - `inet_server_addr()`/`inet_server_port()` des deux connexions doivent
     être **identiques**. C'est la vérification décisive : deux URLs qui
     déclarent le même hôte peuvent, en pratique, aboutir à deux serveurs
     physiques différents (entrée DNS obsolète, hôte équilibré par une
     load-balancer, entrée `/etc/hosts` divergente). Seule une adresse
     serveur réelle, lue depuis une connexion ouverte pour de vrai, le
     prouve.
7. **Lancement de Prisma** — ce n'est qu'après la réussite de **tous** les
   contrôles ci-dessus que `npx prisma migrate deploy` est invoqué.

Toute étape refusée arrête le processus avec le code de sortie **42**
(distinct de `0` = succès et `1` = échec générique), après avoir affiché un
message de refus explicite. **Jamais** une URL complète, un nom
d'utilisateur ou un mot de passe n'est journalisé — seuls l'hôte, le port,
la base de données et le schéma le sont (ces informations ne sont pas des
secrets).

## Procédure production

La production actuelle cible réellement `host=db`, `database=postgres`,
`schema=public` — d'où la présence de `postgres` dans
`EXPECTED_DATABASE_NAME` et l'exigence explicite de
`MIGRATION_ENVIRONMENT=production` dans `.env.production` /
`docker-compose.production.yml` (voir la vérification n°4 ci-dessus).

```bash
# .env.production (jamais versionné avec de vraies valeurs)
DATABASE_URL=postgresql://<user>:<password>@db:5432/postgres?schema=public
DIRECT_URL=postgresql://<user>:<password>@db:5432/postgres?schema=public
EXPECTED_DATABASE_HOST=db
EXPECTED_DATABASE_NAME=postgres
MIGRATION_ENVIRONMENT=production
```

Le déploiement standard (`docker compose -f docker-compose.production.yml
up -d --build`) construit et exécute le service `migrate` avant le service
`backend` (`depends_on: migrate: condition: service_completed_successfully`)
— aucune étape manuelle supplémentaire n'est nécessaire, le garde-fou
s'exécute automatiquement à chaque déploiement.

## Procédure staging (VPS validé)

Le staging validé cible `host=staging-db`, `database=robia_staging` — un nom
de base ordinaire, donc `MIGRATION_ENVIRONMENT` n'a pas besoin d'être défini
(la vérification n°4 ne s'applique qu'aux noms réservés) :

```bash
# .env.staging (exemple, jamais versionné avec de vraies valeurs)
DATABASE_URL=postgresql://<user>:<password>@staging-db:5432/robia_staging?schema=public
DIRECT_URL=postgresql://<user>:<password>@staging-db:5432/robia_staging?schema=public
EXPECTED_DATABASE_HOST=staging-db
EXPECTED_DATABASE_NAME=robia_staging
```

## Sorties attendues

**Succès** — chaque étape de contrôle est journalisée (hôte/base/schéma
déclarés puis réels), suivie de la sortie normale de
`prisma migrate deploy` :

```
[safe-prisma-migrate] cible runtime déclarée (DATABASE_URL) : host=db port=5432 database=postgres schema=public
[safe-prisma-migrate] cible migration déclarée (DIRECT_URL) : host=db port=5432 database=postgres schema=public
[safe-prisma-migrate] identité réelle runtime : database=postgres schema=public server=10.0.0.5:5432
[safe-prisma-migrate] identité réelle migration : database=postgres schema=public server=10.0.0.5:5432
[safe-prisma-migrate] tous les contrôles ont réussi — lancement de "prisma migrate deploy".
...
All migrations have been successfully applied.
```

**Refus** — un message unique, explicite, sans aucune information sensible,
suivi d'une sortie avec le code **42** :

```
[safe-prisma-migrate] REFUS : DATABASE_URL et DIRECT_URL ne ciblent pas la même base : host=db port=5432 database=postgres schema=public vs host=qa-db port=5432 database=robia_qa schema=public.
```

## Procédure en cas de refus

1. **Ne jamais contourner le garde-fou** avec une commande Prisma directe
   (`npx prisma migrate deploy`, `docker run ... prisma migrate deploy`, ou
   une modification temporaire du CMD de l'étage `migrate`). Le refus
   signifie précisément que la configuration ne peut pas être prouvée sûre
   — le contourner reproduit exactement l'incident que ce garde-fou existe
   pour empêcher.
2. Lire le message de refus : il nomme la cause exacte (variable absente,
   cibles divergentes, base réservée sans `MIGRATION_ENVIRONMENT`, connexion
   impossible, serveurs réels différents).
3. Corriger `DATABASE_URL`/`DIRECT_URL`/`EXPECTED_DATABASE_HOST`/
   `EXPECTED_DATABASE_NAME`/`MIGRATION_ENVIRONMENT` dans le fichier d'env
   réel utilisé pour ce déploiement (jamais dans le code du garde-fou lui-même).
4. Relancer le déploiement normalement — le garde-fou revalide tout depuis
   le début à chaque exécution.

## Limites connues

- Le garde-fou vérifie la cible **au moment de son exécution**. Il ne
  protège pas contre un changement de cible survenant après son passage
  mais avant que `prisma migrate deploy` (lancé en sous-processus,
  immédiatement après) ne se connecte à son tour.
- `inet_server_addr()` peut retourner `NULL` pour une connexion locale par
  socket Unix — le garde-fou refuse alors, plutôt que de conclure à tort
  que les deux connexions aboutissent au même serveur. En environnement
  Docker (le cas normal), les connexions sont toujours en TCP entre
  conteneurs, donc cette limite ne s'applique pas en pratique.
