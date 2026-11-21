import { CreateScenarioRequest } from '@nexora/shared';
import {
  buildAggregate, D, fiscalMonths, METRIC_SIGNS, runScenario, toStr, varianceBridge, type RateLookup,
} from '@nexora/financial-engine';
import { SemanticError } from '@nexora/semantic-engine';
import { withUser, type Sql } from '@nexora/database';
import { audit, requireAllCompanies, requirePerm, type AuthContext, type Deps } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { loadCatalog, PgFinancialQueryAdapter } from './semantic-adapter.js';
import { loadAccounts, loadCompanies, loadParameters } from './loaders.js';

async function resolveVersionRun(adapter: PgFinancialQueryAdapter, ctx: AuthContext, code: string, fy: number) {
  const v = await adapter.resolveVersion(ctx.organizationId, code, fy);
  if (!v) throw new SemanticError('UNKNOWN_VERSION', `No existe la versión '${code}'`, 404);
  const r = await adapter.resolveRun(ctx.organizationId, v.id);
  if (!r) throw new SemanticError('NO_CONSOLIDATION', `La versión ${v.code} no tiene consolidación disponible`, 404);
  return { version: v, run: r };
}

/** Puente de variación determinista entre dos versiones para una métrica de resultados. */
export async function varianceAnalysis(deps: Deps, ctx: AuthContext, q: { metric: string; version: string; compare_to: string; period: string }) {
  requirePerm(ctx, 'financial.read');
  requireAllCompanies(ctx);
  const signs = METRIC_SIGNS[q.metric];
  if (!signs) throw badRequest(`El puente de variación está disponible para: ${Object.keys(METRIC_SIGNS).join(', ')}`);
  const fy = Number(q.period);
  const adapter = new PgFinancialQueryAdapter(deps.sql, ctx.userId);
  const cur = await resolveVersionRun(adapter, ctx, q.version, fy);
  const base = await resolveVersionRun(adapter, ctx, q.compare_to, fy);
  const [eCur, eBase, rates, companies] = await Promise.all([
    adapter.loadBridgeEntries(cur.run.id), adapter.loadBridgeEntries(base.run.id), adapter.loadRatesApplied(base.run.id),
    adapter.loadCompanies(ctx.organizationId),
  ]);
  const idx = new Map(rates.map((r) => [`${r.fromCurrency}|${r.rateType}|${r.rateType === 'historical' ? '-' : r.periodCode}`, D(r.rate)]));
  const lookup: RateLookup = (ccy, type, period) => idx.get(`${ccy}|${type}|${type === 'historical' ? '-' : period}`);
  const bridge = varianceBridge({ base: eBase, current: eCur, baseRates: lookup, signs, months: new Set(fiscalMonths(fy)) });
  const byId = new Map(companies.map((c) => [c.id, c]));
  const catalog = await loadCatalog(deps.sql);
  const queryId = await adapter.logQuery({ organizationId: ctx.organizationId, userId: ctx.userId, source: 'api',
    request: { kind: 'variance_bridge', ...q }, runIds: [cur.run.id, base.run.id], rowCount: bridge.companies.length, durationMs: 0, status: 'ok' });
  return {
    query_id: queryId,
    metric: q.metric,
    metric_name: catalog.metrics.get(q.metric)?.name ?? q.metric,
    currency: cur.run.presentationCurrency,
    version: { code: cur.version.code, name: cur.version.name, kind: cur.version.kind, run_id: cur.run.id, run_status: cur.run.status },
    compare_to: { code: base.version.code, name: base.version.name, kind: base.version.kind, run_id: base.run.id, run_status: base.run.status },
    ...bridge,
    companies: bridge.companies.map((c) => ({ ...c, code: byId.get(c.companyId)?.code ?? c.companyId, name: byId.get(c.companyId)?.name ?? '' }))
      .sort((a, b) => D(b.current).minus(b.base).abs().comparedTo(D(a.current).minus(a.base).abs())),
    reconciles: D(bridge.residual).abs().lte('0.01'),
    certified: cur.run.status === 'published' && base.run.status === 'published',
  };
}

/** Trazabilidad de una métrica: definición → corrida → componentes → cuentas → asientos. */
export async function metricLineage(deps: Deps, ctx: AuthContext, q: { run_id: string; metric: string; company?: string }) {
  requirePerm(ctx, 'financial.read');
  const { sql } = deps;
  return withUser(sql, ctx.userId, async (tx) => {
    const [run] = await tx<Array<{ id: string; status: string; inputs_hash: string; rules_version: string; engine_version: string; created_at: string;
      finished_at: string; published_at: string | null; version_code: string; version_name: string; parameters: Record<string, string>;
      rates_applied: unknown[]; created_by_name: string | null }>>`
      select r.id, r.status, r.inputs_hash, r.rules_version, r.engine_version, r.created_at, r.finished_at, r.published_at, v.code as version_code,
             v.name as version_name, r.parameters, r.rates_applied, p.full_name as created_by_name
      from gold.consolidation_runs r join core.budget_versions v on v.id = r.budget_version_id
      left join core.users_profiles p on p.user_id = r.created_by
      where r.id = ${q.run_id}`;
    if (!run) throw notFound('Consolidación no encontrada o sin acceso');
    const company = q.company
      ? (await tx<Array<{ id: string; code: string; name: string }>>`select id, code, name from core.companies where code = ${q.company}
          and organization_id = ${ctx.organizationId}`)[0]
      : null;
    if (q.company && !company) throw notFound('Empresa no encontrada o sin acceso');
    const [def] = await tx<Array<{ code: string; name: string; description: string; unit: string; version: number; formula: string;
      components: string[]; aggregation: string; approved_at: string | null }>>`
      select m.code, m.name, m.description, m.unit, v.version, v.formula, v.components, v.aggregation, v.approved_at
      from semantic.metrics m join semantic.metric_versions v on v.metric_code = m.code and v.status = 'approved' where m.code = ${q.metric}`;
    if (!def) throw notFound('Métrica sin definición aprobada');
    const [result] = await tx<Array<{ value: string | null; status: string; missing: string[]; components: Record<string, string | null>;
      computed_at: string; metric_version: number }>>`
      select value::text as value, status, missing, components, computed_at, metric_version from gold.financial_metric_results
      where run_id = ${q.run_id} and metric_code = ${q.metric}
        and ${company ? tx`scope = 'company' and company_id = ${company.id}` : tx`scope = 'group'`}`;
    const accounts = await tx<Array<{ code: string; name: string; category: string; statement: string; company_code: string; translated: string;
      elimination: string; cta: string; adjustment: string; total: string; entries: number }>>`
      select a.code, a.name, a.category, a.statement, c.code as company_code,
             sum(f.translated_amount)::text as translated, sum(f.elimination_amount)::text as elimination, sum(f.cta_amount)::text as cta,
             sum(f.adjustment_amount)::text as adjustment, sum(f.total_amount)::text as total, count(*)::int as entries
      from gold.consolidated_financials f join silver.accounts a on a.id = f.account_id join core.companies c on c.id = f.company_id
      where f.run_id = ${q.run_id} ${company ? tx`and f.company_id = ${company.id}` : tx``}
      group by a.code, a.name, a.category, a.statement, c.code order by a.code, c.code`;
    const files = await tx<Array<{ batch_id: string; file_id: string; original_name: string; sha256: string; uploaded_at: string; company_code: string;
      row_count: number }>>`
      select b.id as batch_id, f.id as file_id, f.original_name, f.sha256, f.uploaded_at, c.code as company_code, b.row_count
      from gold.consolidation_run_inputs i join bronze.ingestion_batches b on b.id = i.batch_id
      join bronze.source_files f on f.id = b.source_file_id join core.companies c on c.id = b.company_id
      where i.run_id = ${q.run_id} ${company ? tx`and b.company_id = ${company.id}` : tx``} order by c.code`;
    const complete = !!result && files.length > 0;
    return {
      metric: def, run, company, result: result ?? null, accounts, files,
      lineage_complete: complete,
      lineage_note: complete ? null : 'Trazabilidad incompleta: el resultado no tiene referencias de origen registradas',
    };
  });
}

/** Asientos de consolidación filtrados (drill-down). */
export async function listEntries(deps: Deps, ctx: AuthContext, q: { run_id: string; account?: string; company?: string; period?: string;
  entry_type?: string; limit?: number }) {
  requirePerm(ctx, 'financial.read');
  return withUser(deps.sql, ctx.userId, (tx) => tx`
    select e.id, e.entry_type, e.period_code, a.code as account_code, a.name as account_name, c.code as company_code,
           e.local_amount::text as local_amount, e.local_currency, e.rate::text as rate, e.rate_type, e.group_amount::text as group_amount,
           e.description, e.source_line_id, e.rate_id
    from gold.consolidation_entries e join silver.accounts a on a.id = e.account_id join core.companies c on c.id = e.company_id
    where e.run_id = ${q.run_id}
      ${q.account ? tx`and a.code = ${q.account}` : tx``}
      ${q.company ? tx`and c.code = ${q.company}` : tx``}
      ${q.period ? tx`and e.period_code = ${q.period}` : tx``}
      ${q.entry_type ? tx`and e.entry_type = ${q.entry_type}` : tx``}
    order by c.code, e.period_code, e.id
    limit ${Math.min(q.limit ?? 200, 1000)}`);
}

/** Cadena completa de un registro normalizado hasta el archivo fuente. */
export async function lineChain(deps: Deps, ctx: AuthContext, lineId: string) {
  requirePerm(ctx, 'data.read');
  return withUser(deps.sql, ctx.userId, async (tx) => {
    const [line] = await tx`
      select l.id, l.row_number, l.account_code, l.account_name, l.period_raw, l.period_code, l.amount_raw, l.amount::text as amount, l.currency,
             l.counterparty_code, l.ic_reference, l.status, l.exclusion_reason, l.corrections, l.line_hash, l.batch_id, l.raw_row_id,
             a.code as group_account_code, a.name as group_account_name, c.code as company_code, c.name as company_name
      from silver.normalized_budget_lines l join core.companies c on c.id = l.company_id
      left join silver.accounts a on a.id = l.account_id where l.id = ${lineId}`;
    if (!line) throw notFound('Registro no encontrado o sin acceso');
    const [raw] = await tx`select id, row_number, data, row_hash, created_at from bronze.raw_budget_rows where id = ${line.raw_row_id}`;
    const [batch] = await tx`select b.id, b.status, b.mapping_snapshot, b.created_at, b.row_count, v.code as version_code,
        f.id as file_id, f.original_name, f.sha256, f.size_bytes, f.uploaded_at, f.storage_path, p.full_name as uploaded_by
      from bronze.ingestion_batches b join bronze.source_files f on f.id = b.source_file_id
      join core.budget_versions v on v.id = b.budget_version_id left join core.users_profiles p on p.user_id = f.uploaded_by
      where b.id = ${line.batch_id}`;
    const issues = await tx`select id, rule_code, severity, status, description, resolution, resolved_at from silver.validation_issues
      where normalized_line_id = ${lineId} order by created_at`;
    const entries = await tx`select e.id, e.run_id, r.status as run_status, e.entry_type, e.rate::text as rate, e.rate_type, e.rate_id,
        e.group_amount::text as group_amount, e.description, x.source as rate_source, x.scenario as rate_scenario
      from gold.consolidation_entries e join gold.consolidation_runs r on r.id = e.run_id
      left join silver.exchange_rates x on x.id = e.rate_id
      where e.source_line_id = ${lineId} order by r.created_at desc, e.id limit 50`;
    return { line, raw_row: raw ?? null, batch: batch ?? null, issues, entries };
  });
}

// ---------------------------------------------------------------- escenarios
export async function createScenario(deps: Deps, ctx: AuthContext, raw: unknown) {
  requirePerm(ctx, 'scenario.create');
  requireAllCompanies(ctx);
  const p = CreateScenarioRequest.safeParse(raw);
  if (!p.success) throw badRequest('Escenario inválido', p.error.issues);
  const req = p.data;
  const fy = Number(req.fiscal_year);
  const adapter = new PgFinancialQueryAdapter(deps.sql, ctx.userId);
  const { version, run } = await resolveVersionRun(adapter, ctx, req.base_version, fy);
  const [fin, accounts, params, companies] = await Promise.all([
    adapter.loadFinancials(run.id), loadAccounts(deps.sql, ctx.organizationId), loadParameters(deps.sql, ctx.organizationId, fy),
    loadCompanies(deps.sql, ctx.organizationId),
  ]);
  const aggregate = buildAggregate(fin, accounts, { mode: 'consolidated', fiscalYear: fy, params });
  const foreign = new Set(companies.filter((c) => c.functionalCurrency !== ctx.presentationCurrency).map((c) => c.id));
  const share = (cat: string) => {
    const ids = new Set(accounts.filter((a) => a.category === cat).map((a) => a.id));
    const rows = fin.filter((f) => ids.has(f.accountId) && fiscalMonths(fy).includes(f.periodCode));
    const total = rows.reduce((s, f) => s.plus(f.translated), D(0));
    const fx = rows.filter((f) => foreign.has(f.companyId)).reduce((s, f) => s.plus(f.translated), D(0));
    return total.isZero() ? D(0) : fx.div(total);
  };
  const result = runScenario({ aggregate, foreignShare: { revenue: share('revenue'), cogs: share('cogs'), opex: share('opex') } }, req.assumptions);
  const id = await deps.sql.begin(async (tx) => {
    const [s] = await tx<Array<{ id: string }>>`
      insert into scenarios.scenarios (organization_id, base_run_id, name, description, status, created_by, computed_at)
      values (${ctx.organizationId}, ${run.id}, ${req.name}, ${req.description}, ${result.status}, ${ctx.userId}, now()) returning id`;
    const assumptions = Object.entries(req.assumptions).map(([code, value]) => ({ scenario_id: s!.id, code, value, description: code }));
    if (assumptions.length) await tx`insert into scenarios.scenario_assumptions ${tx(assumptions)}`;
    await tx`insert into scenarios.scenario_results ${tx(result.metrics.map((m) => ({
      scenario_id: s!.id, metric_code: m.metricCode, base_value: m.base, scenario_value: m.scenario, delta: m.delta, unit: m.unit,
      status: m.status, missing: m.missing,
    })))}`;
    await audit(tx, ctx, 'scenario.create', 'scenario', s!.id, { base_run: run.id, assumptions: req.assumptions });
    return s!.id;
  });
  return { id, name: req.name, base: { version: version.code, run_id: run.id, run_status: run.status }, data_nature: 'simulation', ...result };
}

export async function listScenarios(sql: Sql, ctx: AuthContext) {
  return withUser(sql, ctx.userId, (tx) => tx`
    select s.id, s.name, s.description, s.status, s.created_at, v.code as base_version, r.status as base_run_status,
           (select jsonb_object_agg(code, value::text) from scenarios.scenario_assumptions a where a.scenario_id = s.id) as assumptions,
           (select jsonb_agg(jsonb_build_object('metric', metric_code, 'base', base_value::text, 'scenario', scenario_value::text,
              'delta', delta::text, 'unit', unit, 'status', status, 'missing', missing) order by metric_code)
            from scenarios.scenario_results x where x.scenario_id = s.id) as results
    from scenarios.scenarios s join gold.consolidation_runs r on r.id = s.base_run_id
    join core.budget_versions v on v.id = r.budget_version_id
    where s.organization_id = ${ctx.organizationId} order by s.created_at desc limit 50`);
}

export { toStr };
