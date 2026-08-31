# GitHub Actions → VPS ROBIA

## Mise en service progressive

Les secrets seuls n'activent aucun déploiement. Le job `deploy` reste ignoré tant que la **variable de dépôt** `VPS_DEPLOY_ENABLED` n'est pas exactement `true`. Elle est distincte des secrets. Ne l'activez qu'après installation du nouveau dispatcher.

Le workflow `Backend CI` conserve ses contrôles NestJS, Python et images Docker. Le job de déploiement dépend de tous ces contrôles, ainsi que des tests du dispatcher. Il ne s'exécute que sur `main`, après un `push` ou un lancement manuel. Les PR ne reçoivent pas les secrets de déploiement dans ce job.

## Secrets dans chacun des deux dépôts

Dans `Settings → Secrets and variables → Actions → Secrets` :

| Secret | Valeur |
| --- | --- |
| `VPS_HOST` | `169.58.241.220` |
| `VPS_USER` | `robia` |
| `VPS_SSH_KEY` | Clé privée OpenSSH dédiée, complète et sans passphrase |
| `VPS_KNOWN_HOSTS` | Ligne `169.58.241.220 ssh-ed25519 <clé publique du VPS>` |

Obtenir la ligne d'identité depuis une session VPS déjà authentifiée :

`awk '{print "169.58.241.220 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub`

Le workflow impose `StrictHostKeyChecking=yes`, utilise cette identité pré-enregistrée et ne fait pas de `ssh-keyscan` à l'exécution. Il n'affiche pas la clé privée et nettoie les deux fichiers SSH temporaires en fin d'étape.

## Installation VPS, après fusion autorisée de la PR backend

Exécuter comme `robia`, garder la connexion SSH personnelle ouverte. Le serveur doit disposer de Bash, Git, Docker Compose, `flock`, `jq`, curl et du script de sauvegarde déjà testé.

`cd /srv/robia/robia-back && git status --short`

Si la sortie est vide :

`git pull --ff-only origin main`

`test -r /srv/robia/scripts/backup-supabase.sh && bash -n /srv/robia/scripts/backup-supabase.sh && echo BACKUP_SCRIPT=READY`

Le script de sauvegarde utilise Bash, notamment `set -euo pipefail` : ne pas le lancer avec `sh` et ne pas supprimer `pipefail`. La validation de syntaxe ne prouve pas que la sauvegarde fonctionne. Effectuer un test réel, sans `sudo`, avant activation :

`bash /srv/robia/scripts/backup-supabase.sh && echo BACKUP_AS_ROBIA=OK`

Ne contrôler le manifeste le plus récent qu'après la réussite de ce test : un manifeste ancien intact ne valide pas une tentative échouée.

Le script de sauvegarde doit réellement fonctionner comme `robia`, retourner une erreur si une étape échoue, vérifier ses archives, et produire les sauvegardes PostgreSQL et des rôles sans afficher de secrets. Ne pas accorder de sudo général si cette vérification échoue : corriger précisément les permissions nécessaires.

Sauvegarder le dispatcher actuellement installé, puis installer la version contrôlée :

`cp -p /srv/robia/scripts/github-deploy.sh /srv/robia/scripts/github-deploy.sh.before-ci-$(date -u +%Y%m%d-%H%M%S)`

`sh -n deploy/github-deploy.sh && install -m 700 deploy/github-deploy.sh /srv/robia/scripts/github-deploy.sh`

La ligne existante de `authorized_keys` reste inchangée :

`restrict,command="/srv/robia/scripts/github-deploy.sh" ssh-ed25519 <clé publique dédiée> github-actions@robia.digital`

Le nouveau protocole accepte seulement `deploy-backend <SHA complet>` ou `deploy-frontend <SHA complet>`. L'ancien appel sans SHA est volontairement refusé. Le test `invalid` doit toujours répondre `Command denied`, code 1.

## Contrôles du dispatcher

- Verrou partagé aux deux dépôts ; attente maximale de 20 minutes.
- Branche locale `main`, aucun fichier local modifié ou non suivi ; `.env.production` ignoré reste intact.
- SHA de 40 caractères hexadécimaux minuscules, identique au `main` distant récupéré. Un ancien workflow ne déploie pas un nouveau commit non testé ; relancer la CI du `main` courant si le job est périmé.
- Mise à jour en avance rapide uniquement, sans `reset --hard`, `clean` ou suppression de volumes.
- Validation Compose et refus de tout port applicatif publié.
- Construction avant mise à jour des conteneurs ; pour le backend, sauvegarde avant démarrage des migrations.
- Vérification du code de sortie de la migration, attente bornée des healthchecks et réponses HTTPS exactement `200` avec validation TLS.
- SHA de la dernière exécution réussie enregistré dans `/srv/robia/deployments/backend.last-successful-sha` ou `frontend.last-successful-sha`.

## Premier déploiement et activation

1. Vérifier que les PR backend et frontend autorisées ont été fusionnées, leurs contrôles CI sont verts, et que le dispatcher ci-dessus est installé.
2. Dans le dépôt backend, `Settings → Secrets and variables → Actions → Variables → New repository variable` : définir `VPS_DEPLOY_ENABLED` à `true`.
3. Dans `Actions → Backend CI → Run workflow`, sélectionner `main` et lancer une exécution. Cela reconstruit, sauvegarde, migre si nécessaire et redémarre les services. Une brève interruption applicative est possible.
4. Vérifier le succès et `https://api.robiacopilot.site/health`, puis procéder de la même façon pour `Frontend production images` dans le monorepo.
5. Une fois la variable activée, les prochains `push` sur `main` déploient automatiquement après leurs contrôles. Un merge de PR provoque un tel push.

Le workflow ne lit jamais `.env.production` depuis GitHub : les secrets applicatifs restent sur le VPS. Les builds CI et VPS sont distincts ; le SHA est fixé, mais les images ne sont pas encore promues par digest depuis un registre.

## Échec et retour arrière

Le système signale les erreurs, mais **n'effectue pas de rollback automatique**, notamment pour PostgreSQL. Un `up` échoué peut avoir modifié une partie des conteneurs. La disponibilité antérieure n'est donc pas garantie après le début de cette étape.

Mettre `VPS_DEPLOY_ENABLED` à `false` dans les deux dépôts pour suspendre les futurs déploiements. Cela n'arrête pas un job déjà en cours. Ne pas effectuer un déploiement manuel en parallèle. Consulter les journaux, le SHA de la dernière réussite et `DEPLOYMENT.md` ; choisir explicitement une version compatible avec les migrations avant toute restauration. Ne jamais restaurer la base de production automatiquement.

Protéger `main` et les modifications de workflows par revue et contrôles obligatoires. La commande forcée limite les commandes SSH directes, mais n'est pas un bac à sable : le code et les fichiers Docker autorisés dans `main` s'exécutent avec les capacités de `robia`, notamment son accès à Docker. Une compromission de ces dépôts ou de leurs administrateurs reste critique.

## Tests isolés

`sh -n deploy/github-deploy.sh && python3 -m unittest discover -s deploy/tests -p 'test_*.py' -v`

Ces tests utilisent des dépôts Git temporaires, un faux Docker et un faux client HTTP. Aucun accès au VPS ni aux données de production.
