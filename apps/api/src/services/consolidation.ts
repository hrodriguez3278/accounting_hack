import { consolidate, computeInputsHash, ENGINE_VERSION, type ConsolidationInput, type Line } from '@nexora/financial-engine';
import { rulesVersion } from '@nexora/validation-engine';
import type { Sql } from '@nexora/database';
import { approvalEvent, audit, requireAllCompanies, requirePerm, type AuthContext, type Deps } from '../context.js';
import { conflict, notFound } from '../errors.js';
import {
  loadAcceptances, loadAccounts, loadApprovedRates, loadCompanies, loadParameters, loadRules, loadVersion, trimDecimal,
} from './loaders.js';
import { validateVersion } from './validation.js';

export async function loadConsolidationInput(sql: Sql, organizationId: string, versionId: string): Promise<{ input: ConsolidationInput; batchIds: string[] }> {
  const version = await loadVersion(sql, organizationId, versionId);
  const [org] = await sql<Array<{ presentation_currency: string }>>`select presentation_currency from core.organizations where id = ${organizationId}`;
  const [companies, accounts, rates, parameters, acceptances, rules] = await Promise.all([
    loadCompanies(sql, organizationId), loadAccounts(sql, organizationId), loadApprovedRates(sql, organizationId, version.rate_scenario),
    loadParameters(sql, organizationId, version.fiscal_year), loadAcceptances(sql, versionId), loadRules(sql),
  ]);
  const rows = await sql<Array<{ id: string; company_id: string; account_id: string; period_code: string; amount: string; currency: string;
    counterparty_code: string | null; ic_reference: string | null; line_hash: string; batch_id: string }>>`
    select l.id, l.company_id, l.account_id, l.period_code, l.amount::text as amount, l.currency, l.counterparty_code, l.ic_reference,
           l.line_hash, l.batch_id
    from silver.normalized_budget_lines l
    join bronze.ingestion_batches b on b.id = l.batch_id and b.status = 'processed'
    where l.budget_version_id = ${versionId} and l.status = 'valid'`;
  const adjustments = await sql<Array<{ id: string; company_id: string; account_id: string; period_code: string; amount: string; description: string }>>`
    select id, company_id, account_id, period_code, amount::text as amount, description from gold.consolidation_adjustments
    where budget_version_id = ${versionId} and status = 'approved'`;
  const lines: Line[] = rows.map((r) => ({
    id: r.id, companyId: r.company_id, accountId: r.account_id, periodCode: r.period_code, amount: trimDecimal(r.amount), currency: r.currency,
    counterpartyCode: r.counterparty_code, icReference: r.ic_reference, lineHash: r.line_hash,
  }));
  return {
    input: {
      organizationId, versionId, fiscalYear: version.fiscal_year, presentationCurrency: org!.presentation_currency,
      rateScenario: version.rate_scenario, includesBalanceSheet: version.includes_balance_sheet, companies, accounts, lines, rates,
      adjustments: adjustments.map((a) => ({ id: a.id, companyId: a.company_id, accountId: a.account_id, periodCode: a.period_code,
        amount: trimDecimal(a.amount), description: a.description })),
      acceptances, parameters, rulesVersion: rulesVersion(rules),
    },
    batchIds: [...new Set(rows.map((r) => r.batch_id))],
  };
}

export interface RunRow {
  id: string;
  status: string;
  budget_version_id: string;
  inputs_hash: string | null;
  summary: Record<string, unknown>;
  blocking_issues: number;
  created_at: string;
  finished_at: string | null;
  approved_at: string | null;
  published_at: string | null;
  error: string | null;
}

/** Ejecuta una consolidación completa. Nunca sobrescribe corridas existentes: siempre crea una nueva. */
export async function runConsolidation(deps: Deps, ctx: AuthContext, versionId: string): Promise<RunRow> {
  requirePerm(ctx, 'consolidation.run');
  requireAllCompanies(ctx);
  const { sql } = deps;
  const version = await loadVersion(sql, ctx.organizationId, versionId);
  const [run] = await sql<Array<{ id: string }>>`
    insert into gold.consolidation_runs (organization_id, budget_version_id, fiscal_year, presentation_currency, rules_version, engine_version, created_by)
    values (${ctx.organizationId}, ${versionId}, ${version.fiscal_year}, ${ctx.presentationCurrency}, 'pending', ${ENGINE_VERSION}, ${ctx.userId})
    returning id`;
  const runId = run!.id;
  await sql`update gold.consolidation_runs set status = 'validating' where id = ${runId}`;
  await audit(sql, ctx, 'consolidation.start', 'consolidation_run', runId, { version: version.code });

  try {
    const validation = await validateVersion(sql, ctx.organizationId, versionId, ctx.userId);
    const { input, batchIds } = await loadConsolidationInput(sql, ctx.organizationId, versionId);
    if (input.lines.length === 0) {
      await sql`update gold.consolidation_runs set status = 'blocked', blocking_issues = 1, rules_version = ${input.rulesVersion},
          finished_at = now(), summary = ${JSON.stringify({ validation, reason: 'La versión no tiene registros válidos procesados' })}::text::jsonb
        where id = ${runId}`;
      return getRun(sql, ctx, runId);
    }
    if (validation.open_critical > 0) {
      await sql`update gold.consolidation_runs set status = 'blocked', blocking_issues = ${validation.open_critical},
          rules_version = ${input.rulesVersion}, finished_at = now(),
          summary = ${JSON.stringify({ validation, reason: 'Incidencias críticas abiertas' })}::text::jsonb
        where id = ${runId}`;
      return getRun(sql, ctx, runId);
    }
    const result = consolidate(input);
    if (result.blockingReasons.length) {
      await sql`update gold.consolidation_runs set status = 'blocked', blocking_issues = ${result.blockingReasons.length},
          rules_version = ${input.rulesVersion}, finished_at = now(), inputs_hash = ${result.inputsHash},
          summary = ${JSON.stringify({ validation, blocking: result.blockingReasons.slice(0, 50) })}::text::jsonb
        where id = ${runId}`;
      return getRun(sql, ctx, runId);
    }
    await sql.begin(async (tx) => {
      if (batchIds.length) await tx`insert into gold.consolidation_run_inputs ${tx(batchIds.map((b) => ({ run_id: runId, batch_id: b })))}`;
      const matchIds = await tx<Array<{ id: string; ic_reference: string }>>`
        select id, ic_reference from silver.current_intercompany_matches where budget_version_id = ${versionId}`;
      const matchByRef = new Map(matchIds.map((m) => [m.ic_reference, m.id]));
      const entries = result.entries.map((e) => ({
        run_id: runId, company_id: e.companyId, account_id: e.accountId, period_code: e.periodCode, entry_type: e.entryType,
        source_line_id: e.sourceLineId, ic_match_id: e.entryType === 'elimination' && e.icReference ? matchByRef.get(e.icReference) ?? null : null,
        adjustment_id: e.adjustmentId, local_amount: e.localAmount, local_currency: e.localCurrency, rate: e.rate, rate_type: e.rateType,
        rate_id: e.rateId, group_amount: e.groupAmount, description: e.description,
      }));
      for (let i = 0; i < entries.length; i += 1000) await tx`insert into gold.consolidation_entries ${tx(entries.slice(i, i + 1000))}`;
      const fin = result.financials.map((f) => ({
        run_id: runId, company_id: f.companyId, account_id: f.accountId, period_code: f.periodCode, translated_amount: f.translated,
        elimination_amount: f.elimination, cta_amount: f.cta, adjustment_amount: f.adjustment, total_amount: f.total,
      }));
      for (let i = 0; i < fin.length; i += 1000) await tx`insert into gold.consolidated_financials ${tx(fin.slice(i, i + 1000))}`;
      const versions = await tx<Array<{ metric_code: string; version: number }>>`
        select metric_code, version from semantic.metric_versions where status = 'approved'`;
      const mv = new Map(versions.map((v) => [v.metric_code, v.version]));
      const metrics = result.metrics.filter((m) => mv.has(m.metricCode)).map((m) => ({
        run_id: runId, metric_code: m.metricCode, metric_version: mv.get(m.metricCode)!, scope: m.scope, company_id: m.companyId,
        period_label: m.periodLabel, value: m.value, unit: m.unit, status: m.status, missing: m.missing,
        components: m.components,
      }));
      if (metrics.length) await tx`insert into gold.financial_metric_results ${tx(metrics)}`;
      await tx`update gold.consolidation_runs set status = 'ready_for_review', inputs_hash = ${result.inputsHash},
          rules_version = ${input.rulesVersion}, parameters = ${JSON.stringify(input.parameters)}::text::jsonb,
          rates_applied = ${JSON.stringify(result.ratesApplied)}::text::jsonb,
          summary = ${JSON.stringify({ ...result.summary, validation })}::text::jsonb, finished_at = now()
        where id = ${runId}`;
    });
    await audit(sql, ctx, 'consolidation.ready', 'consolidation_run', runId, { inputs_hash: result.inputsHash });
    return getRun(sql, ctx, runId);
  } catch (e) {
    await sql`update gold.consolidation_runs set status = 'failed', error = ${(e as Error).message.slice(0, 500)}, finished_at = now()
      where id = ${runId} and status in ('draft', 'validating')`;
    throw e;
  }
}

export async function getRun(sql: Sql, ctx: AuthContext, runId: string): Promise<RunRow> {
  const [r] = await sql<RunRow[]>`select id, status, budget_version_id, inputs_hash, summary, blocking_issues, created_at, finished_at,
      approved_at, published_at, error
    from gold.consolidation_runs where id = ${runId} and organization_id = ${ctx.organizationId}`;
  if (!r) throw notFound('Consolidación no encontrada');
  return r;
}

/** Transiciones de aprobación y publicación. Verifica que las entradas no hayan cambiado desde la ejecución. */
export async function transitionRun(deps: Deps, ctx: AuthContext, runId: string, to: 'approved' | 'published', reason: string): Promise<RunRow> {
  const { sql } = deps;
  const run = await getRun(sql, ctx, runId);
  if (to === 'approved') {
    requirePerm(ctx, 'consolidation.approve');
    if (run.status !== 'ready_for_review') throw conflict(`Solo se aprueba una consolidación lista para revisión (estado actual: ${run.status})`);
    const [w] = await sql<Array<{ n: number }>>`select count(*)::int as n from silver.validation_issues
      where budget_version_id = ${run.budget_version_id} and status = 'open' and severity in ('critical', 'warning')`;
    if (w!.n > 0) throw conflict(`Existen ${w!.n} incidencias abiertas (críticas o advertencias sin aceptar)`);
  } else {
    requirePerm(ctx, 'consolidation.publish');
    if (run.status !== 'approved') throw conflict(`Solo se publica una consolidación aprobada (estado actual: ${run.status})`);
  }
  const { input } = await loadConsolidationInput(sql, ctx.organizationId, run.budget_version_id);
  if (computeInputsHash(input) !== run.inputs_hash) {
    throw conflict('Los datos de entrada cambiaron desde la ejecución: ejecute una nueva consolidación');
  }
  await sql.begin(async (tx) => {
    if (to === 'approved') {
      await tx`update gold.consolidation_runs set status = 'approved', approved_by = ${ctx.userId}, approved_at = now() where id = ${runId}`;
    } else {
      await tx`update gold.consolidation_runs set status = 'superseded'
        where budget_version_id = ${run.budget_version_id} and status = 'published'`;
      await tx`update gold.consolidation_runs set status = 'published', published_by = ${ctx.userId}, published_at = now() where id = ${runId}`;
    }
    await approvalEvent(tx, ctx, 'consolidation_run', runId, to === 'approved' ? 'approve' : 'publish', run.status, to, reason);
  });
  return getRun(sql, ctx, runId);
}

/** Compara las métricas de dos corridas (p.ej. re-ejecución de la misma versión). */
export async function compareRuns(sql: Sql, ctx: AuthContext, a: string, b: string) {
  await getRun(sql, ctx, a);
  await getRun(sql, ctx, b);
  const rows = await sql<Array<{ metric_code: string; scope: string; company_code: string | null; a: string | null; b: string | null }>>`
    select coalesce(x.metric_code, y.metric_code) as metric_code, coalesce(x.scope, y.scope) as scope, c.code as company_code,
           x.value::text as a, y.value::text as b
    from (select * from gold.financial_metric_results where run_id = ${a}) x
    full join (select * from gold.financial_metric_results where run_id = ${b}) y
      on x.metric_code = y.metric_code and x.scope = y.scope and x.company_id is not distinct from y.company_id
    left join core.companies c on c.id = coalesce(x.company_id, y.company_id)
    order by 2, 3 nulls first, 1`;
  const [ha, hb] = await sql<Array<{ inputs_hash: string }>>`select inputs_hash from gold.consolidation_runs where id in (${a}, ${b})
    order by array_position(array[${a}::uuid, ${b}::uuid], id)`;
  return {
    same_inputs: ha?.inputs_hash === hb?.inputs_hash,
    differences: rows.filter((r) => r.a !== r.b),
    compared: rows.length,
  };
}
