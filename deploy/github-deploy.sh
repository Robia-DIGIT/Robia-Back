#!/bin/sh
# Install outside the checkout at /srv/robia/scripts/github-deploy.sh.
# Invoked exclusively by the forced command in authorized_keys; never eval input.
set -eu
umask 077
export GIT_TERMINAL_PROMPT=0
unset CDPATH

fail() { printf '%s\n' "$*" >&2; exit 1; }

case "${SSH_ORIGINAL_COMMAND:-}" in
  'deploy-backend '*)
    target=backend
    sha=${SSH_ORIGINAL_COMMAND#deploy-backend }
    repo=/srv/robia/robia-back
    ;;
  'deploy-frontend '*)
    target=frontend
    sha=${SSH_ORIGINAL_COMMAND#deploy-frontend }
    repo=/srv/robia/robia-monorepo
    ;;
  *) fail 'Command denied' ;;
esac
case "$sha" in ''|*[!0-9a-f]*) fail 'Expected a full lowercase commit SHA' ;; esac
[ "${#sha}" -eq 40 ] || fail 'Expected a full lowercase commit SHA'

# Shared across both repositories, including independently running workflows.
exec 9>/srv/robia/.github-deploy.lock
flock -w 1200 9 || fail 'Another deployment is still running; retry later'
cd "$repo"
[ "$(git symbolic-ref --short HEAD)" = main ] || fail 'Checkout must be on main'
[ -z "$(git status --porcelain)" ] || fail 'Checkout has local changes; refusing deployment'
git fetch origin main
[ "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$sha" ] || fail 'Stale or non-main commit; run CI for the current main'
git merge-base --is-ancestor HEAD "$sha" || fail 'Local main has diverged; operator intervention required'
printf 'CHECKOUT_BEFORE=%s TARGET=%s COMMIT=%s\n' "$(git rev-parse HEAD)" "$target" "$sha"
git merge --ff-only "$sha"

compose() {
  if [ "$target" = backend ]; then
    docker compose --env-file .env.production -f docker-compose.production.yml "$@"
  else
    docker compose -f docker-compose.frontend.production.yml "$@"
  fi
}

wait_healthy() {
  service=$1
  container=$(compose ps -a -q "$service")
  [ -n "$container" ] || fail "Missing container: $service"
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container")
    case "$state" in
      'running healthy') printf '%s=healthy\n' "$service"; return 0 ;;
      'exited '*|'dead '*|*' missing') fail "$service cannot become healthy: $state" ;;
    esac
    attempt=$((attempt + 1))
    sleep 3
  done
  fail "Health timeout: $service"
}

check_https() {
  url=$1
  attempt=0
  while [ "$attempt" -lt 6 ]; do
    status=$(curl --silent --show-error --connect-timeout 5 --max-time 15 --output /dev/null --write-out '%{http_code}' "$url") || status=000
    if [ "$status" = 200 ]; then printf 'HTTPS_OK=%s\n' "$url"; return 0; fi
    attempt=$((attempt + 1))
    sleep 3
  done
  fail "HTTPS check failed: $url (HTTP $status)"
}

compose config --quiet
# Inspect only port counts; never print the resolved configuration or secrets.
compose config --format json | jq -e 'all(.services[]; ((.ports // []) | length) == 0)' >/dev/null || fail 'Application ports must not be published'
compose build
if [ "$target" = backend ]; then
  # The existing backup routine must run as robia and return nonzero on failure.
  [ -r /srv/robia/scripts/backup-supabase.sh ] || fail 'Backup script is unavailable'
  sh /srv/robia/scripts/backup-supabase.sh || fail 'Backup failed; containers have not been updated'
fi
compose up -d --no-build
if [ "$target" = backend ]; then
  migration=$(compose ps -a -q migrate)
  [ -n "$migration" ] || fail 'Missing migration container'
  [ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$migration")" = 'exited 0' ] || fail 'Migration did not complete successfully'
  wait_healthy ai-engine
  wait_healthy backend
  check_https https://api.robiacopilot.site/health
else
  wait_healthy dashboard
  wait_healthy vitrine
  check_https https://app.robiacopilot.site/login
  check_https https://robiacopilot.site
  check_https https://www.robiacopilot.site
fi
mkdir -p /srv/robia/deployments
printf '%s\n' "$sha" > "/srv/robia/deployments/$target.last-successful-sha"
printf 'DEPLOY_SUCCESS=%s COMMIT=%s\n' "$target" "$sha"
