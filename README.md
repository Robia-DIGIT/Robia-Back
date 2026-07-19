# ROBIA — Backend API

Backend NestJS pour ROBIA, un outil de visibilité SEO locale pour PME et entreprises multi-sites.

## Stack technique

- NestJS + TypeScript
- Prisma 7 + PostgreSQL (extension pgvector)
- JWT (auth stateless)
- Supabase (PostgreSQL en ligne)

## Setup local

```powershell
git clone https://github.com/Nirina-fifalin/Robia-Back.git
cd Robia-Back
npm install
copy .env.example .env
```

Édite `.env` et renseigne tes propres valeurs (voir section Variables d'environnement ci-dessous).

```powershell
npx prisma migrate dev
npm run start:dev
```

Le serveur démarre sur `http://localhost:3001`.

## Variables d'environnement

| Variable | Description |
|---|---|
| `DATABASE_URL` | Connexion PostgreSQL (doit correspondre aux identifiants dans `docker-compose.yml`) |
| `JWT_SECRET` | Clé secrète pour signer les tokens JWT |
| `JWT_EXPIRES_IN` | Durée de validité du token (ex: `7d`) |
| `FRONTEND_URL` | Origine autorisée pour CORS (ex: `http://localhost:3000`) |

## Authentification

Toutes les routes protégées attendent un header :

```
Authorization: Bearer <accessToken>
```

Le token est obtenu via `POST /auth/register` ou `POST /auth/login`.

La plupart des routes nécessitent aussi qu'une **organisation** existe pour l'utilisateur connecté (créée via `POST /organizations`) — sinon elles renvoient une erreur 404 explicite.

## Endpoints

### Auth (`/auth`)

| Méthode | Route | Protégée | Body | Description |
|---|---|---|---|---|
| POST | `/auth/register` | Non | `{ email, password }` | Inscription |
| POST | `/auth/login` | Non | `{ email, password }` | Connexion |
| GET | `/auth/me` | Oui | — | Profil de l'utilisateur connecté |
| POST | `/auth/logout` | Oui | — | Déconnexion (côté client uniquement, JWT stateless) |

### Organizations (`/organizations`)

| Méthode | Route | Protégée | Body | Description |
|---|---|---|---|---|
| POST | `/organizations` | Oui | `{ name, sector?, city?, country? }` | Créer l'organisation (1 par utilisateur) |
| GET | `/organizations/current` | Oui | — | Récupérer l'organisation de l'utilisateur |
| PATCH | `/organizations/current` | Oui | Champs partiels | Modifier l'organisation |

### Websites (`/websites`)

| Méthode | Route | Protégée | Body | Description |
|---|---|---|---|---|
| POST | `/websites` | Oui | `{ url }` | Connecter un nouveau site |
| GET | `/websites` | Oui | — | Lister tous les sites de l'organisation |
| GET | `/websites/:id` | Oui | — | Détail d'un site |

### Audits (`/audits`)

| Méthode | Route | Protégée | Body / Query | Description |
|---|---|---|---|---|
| POST | `/audits/run` | Oui | `{ websiteId }` | Lancer un audit sur un site précis |
| GET | `/audits?website_id=` | Oui | Query: `website_id` | Historique des audits d'un site |
| GET | `/audits/latest?website_id=` | Oui | Query: `website_id` | Dernier audit d'un site |
| GET | `/audits/:id` | Oui | — | Détail d'un audit |

### Opportunities (`/opportunities`)

| Méthode | Route | Protégée | Body / Query | Description |
|---|---|---|---|---|
| POST | `/opportunities/generate` | Oui | `{ auditId }` | Générer les opportunités depuis un audit terminé (max 5) |
| GET | `/opportunities?audit_id=` | Oui | Query: `audit_id` | Lister les opportunités d'un audit |
| GET | `/opportunities/:id` | Oui | — | Détail d'une opportunité |

### Documents (`/documents`)

| Méthode | Route | Protégée | Body / Query | Description |
|---|---|---|---|---|
| POST | `/documents/generate` | Oui | `{ opportunityId, type }` | Générer un document depuis une opportunité |
| GET | `/documents?opportunity_id=` | Oui | Query: `opportunity_id` | Lister les documents d'une opportunité |
| GET | `/documents/:id` | Oui | — | Détail d'un document |
| PATCH | `/documents/:id` | Oui | `{ content }` | Modifier le contenu d'un document (passe en `edited`) |

`type` accepte : `local_page`, `faq`, `meta`, `gbp_post`, `review_reply`, `dev_brief`, `checklist`

### ValidationLogs (`/validations`)

| Méthode | Route | Protégée | Body | Description |
|---|---|---|---|---|
| POST | `/validations` | Oui | `{ documentId, actionType, platform?, status }` | Approuver/rejeter un document |
| GET | `/validations` | Oui | — | Historique des validations |

`actionType` accepte : `publish`, `update`, `reply`
`status` accepte : `approved`, `rejected`

### ActionItems (`/actions`)

| Méthode | Route | Protégée | Body / Query | Description |
|---      |---    |---       |---           |---          |
| POST    | `/actions/generate?opportunity_id=` | Oui | Query: `opportunity_id` | Générer une action depuis une opportunité |
| GET     | `/actions` | Oui | — | Lister toutes les actions |
| GET     | `/actions/export` | Oui | — | Exporter le plan d'action en PDF |
| PATCH   | `/actions/:id/status` | Oui | `{ status }` | Changer le statut d'une action |

`status` accepte : `todo`, `in_progress`, `done`, `blocked`, `ignored`

## Parcours type (pour tester l'API dans l'ordre)

```
1. POST /auth/register
2. POST /organizations
3. POST /websites
4. POST /audits/run          (avec le websiteId de l'étape 3)
5. POST /opportunities/generate  (avec l'auditId de l'étape 4)
6. POST /documents/generate  (avec l'opportunityId de l'étape 5)
7. POST /validations         (avec le documentId de l'étape 6)
8. POST /actions/generate    (avec l'opportunityId de l'étape 5)
9. GET /actions/export        (télécharge le PDF)
```

## Notes importantes

- **Isolation multi-tenant** : chaque utilisateur ne voit que les données de sa propre organisation.
- **Multi-sites** : une organisation peut avoir plusieurs sites (`websites`), chacun avec son propre historique d'audits et d'opportunités, totalement isolés les uns des autres.
- **IA mockée (temporaire)** : les modules Audits, Opportunities, Documents et ActionItems utilisent actuellement des générateurs simulés (`*-generator` / `*-runner`). Un vrai service Python remplacera ces mocks (voir dossier `python-service/` à venir).