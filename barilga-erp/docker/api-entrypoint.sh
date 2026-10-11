#!/bin/sh
set -eu

if [ -z "${JWT_SECRET:-}" ] || [ "$JWT_SECRET" = "change-me-in-production-use-64-random-bytes" ]; then
  echo "Refusing to start: set a strong JWT_SECRET in the production environment." >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Refusing to start: DATABASE_URL is required." >&2
  exit 1
fi

echo "Running Prisma migrations..."
npx prisma migrate deploy --schema=prisma/schema.prisma

echo "Starting NestJS API..."
exec node dist/main.js
