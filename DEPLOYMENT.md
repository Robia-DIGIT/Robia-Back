# Déploiement du backend ROBIA

Cette configuration utilise le PostgreSQL du Supabase auto-hébergé et le réseau Docker `supabase_default`. Aucun port NestJS, FastAPI ou PostgreSQL n'est publié sur Internet. Le moteur FastAPI dispose d'un réseau `egress` dédié pour joindre les sites publics à auditer, tout en restant inaccessible depuis Internet.

## Pré-requis VPS

- Supabase doit être démarré et son réseau `supabase_default` doit exister.
- Les DNS `api.robiacopilot.site` et `supabase.robiacopilot.site` doivent pointer vers le VPS.
- Les ports publics autorisés restent uniquement `80` et `443`.

## Première installation

Placez-vous dans le dépôt backend :

`cd /srv/robia/robia-back`

Récupérez la version validée :

`git switch main`

`git pull --ff-only origin main`

Créez le fichier de secrets local :

`cp .env.production.example .env.production`

Éditez-le sans publier son contenu :

`nano .env.production`

Vérifiez que le réseau Supabase existe :

`docker network inspect supabase_default >/dev/null && echo OK`

Validez la configuration Compose :

`docker compose --env-file .env.production -f docker-compose.production.yml config --quiet`

Construisez les images :

`docker compose --env-file .env.production -f docker-compose.production.yml build`

Exécutez les migrations puis démarrez les services :

`docker compose --env-file .env.production -f docker-compose.production.yml up -d`

Vérifiez les conteneurs :

`docker compose --env-file .env.production -f docker-compose.production.yml ps`

Testez NestJS depuis son conteneur :

`docker compose --env-file .env.production -f docker-compose.production.yml exec backend node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e);process.exit(1)})"`

Testez la résolution DNS et la sortie HTTPS du moteur d'audit :

`docker compose --env-file .env.production -f docker-compose.production.yml exec ai-engine python -c "import requests; r=requests.get('https://example.com', timeout=15); print(r.status_code)"`

Résultat attendu : `200`.

Testez FastAPI depuis son conteneur :

`docker compose --env-file .env.production -f docker-compose.production.yml exec ai-engine python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"`

## Stockage persistant des documents ODC

Les fichiers uploadés par les candidatures ODC (RC-33) sont écrits par le
conteneur `backend` sous `/data/odc-uploads` (variable `ODC_UPLOAD_DIR`,
définie directement dans `docker-compose.production.yml`), monté depuis le
volume Docker nommé `robia_odc_uploads`. Ce volume reste inscriptible même
si `backend` tourne avec `read_only: true` sur le reste de son système de
fichiers, et il survit à `docker compose up -d --build` (recréation du
conteneur) — seule la suppression explicite du volume (`docker volume rm`)
ou de la machine VPS elle-même le détruit.

**Permissions** : le volume est initialisé au premier montage avec le
contenu et les permissions du répertoire `/data/odc-uploads` de l'image
(créé `chown node:node` dans le `Dockerfile`, avant `USER node`) — aucune
intervention manuelle n'est nécessaire au premier déploiement.

**Sauvegarde** : ce volume n'est *pas* couvert par
`/srv/robia/scripts/backup-supabase.sh` (qui ne sauvegarde que PostgreSQL).
Sauvegardez-le séparément, par exemple :

`docker run --rm -v robia-backend_robia_odc_uploads:/data -v /srv/robia/backups:/backup alpine tar czf /backup/odc-uploads-$(date +%Y%m%d).tar.gz -C /data .`

**Restauration** : arrêtez `backend`, videz le volume cible puis
restaurez l'archive, avant de redémarrer :

`docker compose --env-file .env.production -f docker-compose.production.yml stop backend`

`docker run --rm -v robia-backend_robia_odc_uploads:/data -v /srv/robia/backups:/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/odc-uploads-<date>.tar.gz -C /data"`

`docker compose --env-file .env.production -f docker-compose.production.yml start backend`

## Caddy

Ajoutez le bloc de `deploy/Caddyfile.api.example` au Caddy déjà fourni par Supabase, puis rechargez uniquement Caddy. Le conteneur Caddy doit rester connecté à `supabase_default`, où l'alias `robia-api` est disponible.

Test HTTPS externe :

`curl -sS -o /dev/null -w 'HTTP=%{http_code} TLS=%{ssl_verify_result}\n' https://api.robiacopilot.site/health`

Résultat attendu : `HTTP=200 TLS=0`.

## Mise à jour suivante

`cd /srv/robia/robia-back`

`git pull --ff-only origin main`

`docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`

## Retour arrière

Consultez d'abord l'historique et choisissez explicitement un commit validé :

`git log --oneline -10`

Après avoir choisi le commit, créez une branche de restauration au lieu de modifier brutalement `main` :

`git switch -c rollback/production <COMMIT_SHA>`

`docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`

## Interdictions de sécurité

- Ne jamais publier les ports `3001`, `8000`, `5432` ou `6543`.
- Ne jamais committer `.env.production`.
- Ne jamais coller les clés ou mots de passe dans un ticket, une PR ou une conversation.
- Ne pas lancer l'ancien `docker-compose.yml` sur le VPS de production.
