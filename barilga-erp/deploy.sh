#!/usr/bin/env bash
# Barilga ERP — Linux VPS deploy
#
# Checklist (first time):
#   1. Install Docker Engine + Compose plugin
#   2. Clone this repo onto the VPS
#   3. cp .env.production.example .env.production
#   4. Fill JWT_SECRET, POSTGRES_PASSWORD, CORS_ORIGIN, NEXT_PUBLIC_API_URL, QPay, E-Barimt
#   5. chmod +x deploy.sh && ./deploy.sh
#
# Later updates: git pull && ./deploy.sh
#
# Secrets stay in .env.production (not baked into images except NEXT_PUBLIC_API_URL,
# which must be a public URL and is inlined at the Next.js build).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

if [ ! -f .env.production ]; then
  echo "Missing .env.production. Copy .env.production.example and fill production secrets." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
# shellcheck source=/dev/null
. ./.env.production
set +a

if [ -z "${JWT_SECRET:-}" ] || [ "$JWT_SECRET" = "replace-with-64-char-random" ] || [ "$JWT_SECRET" = "change-me-in-production-use-64-random-bytes" ]; then
  echo "Set a unique JWT_SECRET in .env.production before deploying." >&2
  exit 1
fi

if [ -z "${POSTGRES_PASSWORD:-}" ] || [ "$POSTGRES_PASSWORD" = "replace-with-64-char-random" ] || [ "$POSTGRES_PASSWORD" = "barilga" ]; then
  echo "Set a unique POSTGRES_PASSWORD in .env.production (do not use the local default)." >&2
  exit 1
fi

if [ -d .git ]; then
  echo "==> Pulling latest git..."
  git pull --ff-only
fi

echo "==> Building images and starting stack..."
"${COMPOSE[@]}" up -d --build

echo "==> API entrypoint runs: npx prisma migrate deploy"
echo "==> Waiting for API health..."
for i in $(seq 1 30); do
  if docker exec barilga-api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "API is healthy."
    "${COMPOSE[@]}" ps
    echo "Done. Edge: http://<server-ip>/  API via Nginx: http://<server-ip>/api/"
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy in time. Logs:" >&2
"${COMPOSE[@]}" logs --tail=80 api
exit 1
