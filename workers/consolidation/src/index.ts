/**
 * Worker de consolidación (CLI). Ejecuta una corrida fuera del ciclo HTTP, con la identidad y permisos de un usuario.
 *   npm start -w @nexora/worker-consolidation -- --version PRES-2027-V1 --as admin@altavista.example
 * Reutiliza exactamente el servicio de la API: mismas validaciones, autorización y persistencia.
 */
import { ctxFor, demoDeps, versionId } from '../../../scripts/demo-lib.js';
import { runConsolidation } from '../../../apps/api/src/services/consolidation.js';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const version = arg('version');
const email = arg('as');
if (!version || !email) {
  console.error('Uso: --version <CÓDIGO> --as <correo>');
  process.exit(2);
}
const deps = demoDeps();
try {
  const ctx = await ctxFor(deps, email);
  const [v] = await deps.sql<Array<{ id: string }>>`select id from core.budget_versions where organization_id = ${ctx.organizationId} and code = ${version}`;
  const run = await runConsolidation(deps, ctx, v?.id ?? versionId(version));
  console.log(JSON.stringify({ run_id: run.id, status: run.status, inputs_hash: run.inputs_hash, blocking_issues: run.blocking_issues }));
} finally {
  await deps.sql.end();
}
