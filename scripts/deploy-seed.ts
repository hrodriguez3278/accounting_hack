/**
 * Carga de datos DEMO en el despliegue (idempotente: puede ejecutarse en cada arranque sin duplicar nada).
 *
 *   1. Datos maestros del grupo DEMO (empresas, catálogos de cuentas, homologación, tasas y parámetros).
 *   2. Usuarios DEMO y sus accesos.
 *   3. Presupuesto V1 y Proyección: carga real por el pipeline, consolidación, aprobación y publicación.
 *   4. Presupuesto V2: cargado con sus 8 errores sembrados para demostrar Calidad de datos
 *      (con SEED_DEMO_RESOLVE_V2=true se resuelven y se publica también).
 *
 * Requiere: migraciones aplicadas, DATABASE_URL, SUPABASE_URL y SUPABASE_SECRET_KEY.
 * Uso: npm run deploy:seed   (en contenedor: SEED_DEMO=true lo ejecuta antes de iniciar la API)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, consolidateAndPublish, ctxFor, demoDeps, ensureUsers, loadVersionFiles, resolveSeededErrors, versionId,
} from './demo-lib.js';

const log = (m: string) => console.log(`[demo] ${m}`);
const deps = demoDeps();
try {
  const [org] = await deps.sql`select 1 from core.organizations where slug = 'altavista-demo'`;
  if (!org) {
    await deps.sql.begin((tx) => tx.unsafe(readFileSync(join(ROOT, 'supabase/seeds/20_demo_group.sql'), 'utf8')));
    log('Datos maestros del grupo cargados');
  } else {
    log('Datos maestros ya existentes');
  }

  await ensureUsers(deps);
  log('Usuarios DEMO listos');

  const ctx = await ctxFor(deps, 'admin@altavista.example');
  const published = async (code: string) =>
    (await deps.sql`select 1 from gold.consolidation_runs where budget_version_id = ${versionId(code)} and status = 'published'`).length > 0;

  for (const code of ['PRES-2027-V1', 'PROY-2027']) {
    if (await published(code)) { log(`${code} ya publicada`); continue; }
    await loadVersionFiles(deps, ctx, code, log);
    await consolidateAndPublish(deps, ctx, code, log);
  }

  if (!(await published('PRES-2027-V2'))) {
    await loadVersionFiles(deps, ctx, 'PRES-2027-V2', log);
    if (process.env.SEED_DEMO_RESOLVE_V2 === 'true') {
      await resolveSeededErrors(deps, ctx, log);
      await consolidateAndPublish(deps, ctx, 'PRES-2027-V2', log);
    } else {
      log('PRES-2027-V2 cargada con sus incidencias para la demostración de Calidad de datos');
    }
  }
  log('Carga DEMO completa');
} finally {
  await deps.sql.end();
}
