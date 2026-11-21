/**
 * Utilidades de demostración compartidas por scripts y pruebas de integración.
 * Usan los mismos servicios que la API (mismas validaciones y permisos), con la identidad de un usuario demo.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ColumnMappingConfig } from '@nexora/shared';
import { loadEnv } from '../apps/api/src/env.js';
import { createDeps } from '../apps/api/src/app.js';
import { loadMembership, type AuthContext, type Deps } from '../apps/api/src/context.js';
import { createBatch, uploadSourceFile } from '../apps/api/src/services/ingestion.js';
import { createAccountMapping, createExchangeRate, resolveIssue } from '../apps/api/src/services/quality.js';
import { runConsolidation, transitionRun } from '../apps/api/src/services/consolidation.js';
import { validateVersion } from '../apps/api/src/services/validation.js';

export const ROOT = resolve(import.meta.dirname, '..');
export const manifest = JSON.parse(readFileSync(join(ROOT, 'data/demo/manifest.json'), 'utf8'));
/** En producción la contraseña de los usuarios demo es obligatoria (no hay valor por defecto). */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD
  ?? (process.env.NODE_ENV === 'production' ? '' : 'Nexora-Demo-2027!');

export const DEMO_USERS = [
  { email: 'director@altavista.example', name: 'Dirección Financiera (DEMO)', org: 'altavista-demo', role: 'director', all: true },
  { email: 'admin@altavista.example', name: 'Administración Financiera (DEMO)', org: 'altavista-demo', role: 'financial_admin', all: true },
  { email: 'analista@altavista.example', name: 'Analista Guatemala (DEMO)', org: 'altavista-demo', role: 'financial_analyst', all: false,
    companies: ['ALT-ALIM', 'ALT-LOGI'] },
  { email: 'auditor@altavista.example', name: 'Auditoría (DEMO)', org: 'altavista-demo', role: 'auditor', all: true },
  { email: 'director@boreal.example', name: 'Dirección Boreal (DEMO)', org: 'boreal-demo', role: 'director', all: true },
  { email: 'admin@boreal.example', name: 'Administración Boreal (DEMO)', org: 'boreal-demo', role: 'financial_admin', all: true },
] as const;

export function demoDeps(): Deps {
  return createDeps(loadEnv());
}

export async function ensureUsers(deps: Deps): Promise<Map<string, string>> {
  if (DEMO_PASSWORD.length < 10) {
    throw new Error('DEMO_PASSWORD es obligatoria (mínimo 10 caracteres) para crear o actualizar los usuarios demo');
  }
  const ids = new Map<string, string>();
  const { data: list, error } = await deps.admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`Auth: ${error.message}`);
  for (const u of DEMO_USERS) {
    let id = list.users.find((x) => x.email === u.email)?.id;
    if (!id) {
      const { data, error: e } = await deps.admin.auth.admin.createUser({ email: u.email, password: DEMO_PASSWORD, email_confirm: true,
        user_metadata: { full_name: u.name } });
      if (e || !data.user) throw new Error(`No se pudo crear ${u.email}: ${e?.message}`);
      id = data.user.id;
    } else if (process.env.DEMO_PASSWORD) {
      // Rota la contraseña de un usuario demo existente a la indicada en DEMO_PASSWORD
      const { error: e } = await deps.admin.auth.admin.updateUserById(id, { password: DEMO_PASSWORD });
      if (e) throw new Error(`No se pudo actualizar ${u.email}: ${e.message}`);
    }
    ids.set(u.email, id);
    const [org] = await deps.sql<Array<{ id: string }>>`select id from core.organizations where slug = ${u.org}`;
    await deps.sql`insert into core.users_profiles (user_id, full_name, email) values (${id}, ${u.name}, ${u.email})
      on conflict (user_id) do update set full_name = excluded.full_name`;
    await deps.sql`insert into core.organization_members (organization_id, user_id, role_code, all_companies)
      values (${org!.id}, ${id}, ${u.role}, ${u.all}) on conflict (organization_id, user_id) do update set role_code = excluded.role_code,
      all_companies = excluded.all_companies`;
    if ('companies' in u) {
      for (const code of u.companies) {
        await deps.sql`insert into core.company_access (organization_id, user_id, company_id)
          select ${org!.id}, ${id}, c.id from core.companies c where c.organization_id = ${org!.id} and c.code = ${code}
          on conflict do nothing`;
      }
    }
  }
  return ids;
}

export async function ctxFor(deps: Deps, email: string): Promise<AuthContext> {
  const [p] = await deps.sql<Array<{ user_id: string }>>`select user_id from core.users_profiles where email = ${email}`;
  if (!p) throw new Error(`Usuario demo inexistente: ${email}. Ejecute npm run demo:users`);
  return loadMembership(deps.sql, p.user_id, email);
}

export function versionId(code: string): string {
  return manifest.versions.find((v: { code: string }) => v.code === code).id;
}

/** Carga los seis archivos de una versión por el pipeline real (Storage → Bronze → Silver → validación). */
export async function loadVersionFiles(deps: Deps, ctx: AuthContext, code: string, log = console.log) {
  const v = manifest.versions.find((x: { code: string }) => x.code === code);
  const out = [];
  for (const f of v.files as Array<{ company: string; file: string }>) {
    const company = manifest.companies.find((c: { code: string }) => c.code === f.company);
    const bytes = new Uint8Array(readFileSync(join(ROOT, f.file)));
    const up = await uploadSourceFile(deps, ctx, { companyId: company.id, fileName: f.file.split('/').pop()!, bytes });
    const mapping = ColumnMappingConfig.parse(manifest.column_mappings[company.format]);
    const batch = await createBatch(deps, ctx, { company_id: company.id, budget_version_id: v.id, source_file_id: up.source_file_id,
      mapping, save_mapping_as: `Formato ${company.format}` }, { wait: true });
    log(`  ${code} · ${f.company}: ${batch.status} (${batch.row_count} filas${up.duplicate ? ', archivo ya existente' : ''}${batch.reused ? ', lote reutilizado' : ''})`);
    out.push(batch);
  }
  return out;
}

export async function consolidateAndPublish(deps: Deps, ctx: AuthContext, code: string, log = console.log) {
  const run = await runConsolidation(deps, ctx, versionId(code));
  log(`  ${code}: consolidación ${run.id.slice(0, 8)} → ${run.status}`);
  if (run.status !== 'ready_for_review') return run;
  await transitionRun(deps, ctx, run.id, 'approved', 'Aprobación demo');
  const pub = await transitionRun(deps, ctx, run.id, 'published', 'Publicación demo');
  log(`  ${code}: ${pub.status}`);
  return pub;
}

/** Resuelve los errores sembrados de PRES-2027-V2 con las acciones documentadas en el manifiesto. */
export async function resolveSeededErrors(deps: Deps, ctx: AuthContext, log = console.log) {
  const vid = versionId('PRES-2027-V2');
  const open = () => deps.sql<Array<{ id: string; rule_code: string; company_code: string }>>`
    select i.id, i.rule_code, c.code as company_code from silver.validation_issues i left join core.companies c on c.id = i.company_id
    where i.budget_version_id = ${vid} and i.status = 'open' order by i.created_at`;
  for (const err of manifest.seeded_errors as Array<{ type: string; rule: string; resolution: Record<string, string> }>) {
    const r = err.resolution;
    if (r.action === 'map_account') {
      const company = manifest.companies.find((c: { code: string }) => c.code === 'ALT-LOGI');
      await createAccountMapping(deps, ctx, { company_id: company.id, company_account_code: r.company_account, account_code: r.group_account });
      log(`  ✓ ${err.rule}: cuenta ${r.company_account} homologada a ${r.group_account}`);
    } else if (r.action === 'add_rate') {
      await createExchangeRate(deps, ctx, { from_currency: r.from, to_currency: r.to, period_code: r.period, rate_type: r.rate_type,
        scenario: r.scenario, rate: r.rate, source: 'Supuesto DEMO aprobado (resolución de incidencia)' });
      log(`  ✓ ${err.rule}: tasa ${r.from}/${r.to} ${r.period} registrada`);
    }
  }
  for (const i of await open()) {
    const err = manifest.seeded_errors.find((e: { rule: string }) => e.rule === i.rule_code);
    if (!err || err.rule === 'IC_MISMATCH') continue;
    const r = err.resolution;
    const body = r.action === 'exclude_line' ? { action: 'exclude_line', reason: `Error sembrado ${err.id}: ${err.detail}` }
      : { action: 'correct_field', field: r.field, value: r.value, reason: `Error sembrado ${err.id}: ${err.detail}` };
    await resolveIssue(deps, ctx, i.id, body);
    log(`  ✓ ${i.rule_code} (${i.company_code}): ${r.action}`);
  }
  for (const i of await open()) {
    if (i.rule_code === 'IC_MISMATCH') {
      await resolveIssue(deps, ctx, i.id, { action: 'accept_ic_difference', reason: 'Diferencia documentada; se elimina y registra en 8100' });
      log(`  ✓ IC_MISMATCH: diferencia aceptada con aprobación`);
    }
  }
  return validateVersion(deps.sql, ctx.organizationId, vid, ctx.userId);
}
