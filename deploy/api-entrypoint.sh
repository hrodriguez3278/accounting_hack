#!/bin/sh
set -e
# SEED_DEMO=true carga (o completa) los datos DEMO antes de iniciar la API. Es idempotente.
if [ "$SEED_DEMO" = "true" ]; then
  echo "[deploy] Cargando datos DEMO…"
  node --import tsx scripts/deploy-seed.ts
fi
exec node --import tsx apps/api/src/server.ts
