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
