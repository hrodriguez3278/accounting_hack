import { withUser, type Sql } from '@nexora/database';
import type { BridgeEntry, FinancialRow } from '@nexora/financial-engine';
import type { Catalog, CatalogMetric, FinancialQueryAdapter, RunInfo, VersionInfo } from '@nexora/semantic-engine';
import { loadAccounts, loadCompanies, loadParameters, trimDecimal } from './loaders.js';

let catalogCache: { at: number; catalog: Catalog } | null = null;

export async function loadCatalog(sql: Sql): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.catalog;
  const metrics = await sql<Array<{ code: string; name: string; description: string; unit: 'currency' | 'ratio'; category: string;
    higher_is_better: boolean; version: number | null; formula: string | null; components: string[] | null; dimensions: string[] }>>`
    select m.code, m.name, m.description, m.unit, m.category, m.higher_is_better, v.version, v.formula, v.components,
           coalesce(array_agg(md.dimension_code) filter (where md.dimension_code is not null), '{}') as dimensions
    from semantic.metrics m
    left join semantic.metric_versions v on v.metric_code = m.code and v.status = 'approved'
    left join semantic.metric_dimensions md on md.metric_code = m.code
    group by m.code, m.name, m.description, m.unit, m.category, m.higher_is_better, v.version, v.formula, v.components
    order by m.code`;
  const dims = await sql<Array<{ code: string; name: string; description: string }>>`select code, name, description from semantic.dimensions`;
  const syn = await sql<Array<{ term: string; target_type: 'metric' | 'dimension' | 'chart'; target_code: string }>>`
    select term, target_type, target_code from semantic.synonyms`;
  const catalog: Catalog = {
    metrics: new Map(metrics.map((m): [string, CatalogMetric] => [m.code, {
      code: m.code, name: m.name, description: m.description, unit: m.unit, category: m.category, higherIsBetter: m.higher_is_better,
      version: m.version, formula: m.formula, components: m.components ?? [], dimensions: m.dimensions,
    }])),
    dimensions: new Map(dims.map((d) => [d.code, d])),
    synonyms: syn.map((s) => ({ term: s.term, targetType: s.target_type, targetCode: s.target_code })),
  };
  catalogCache = { at: Date.now(), catalog };
  return catalog;
}

export function invalidateCatalog(): void { catalogCache = null; }

/** Implementación PostgreSQL del contrato FinancialQueryAdapter. Las lecturas financieras se ejecutan bajo RLS. */
export class PgFinancialQueryAdapter implements FinancialQueryAdapter {
  constructor(private readonly sql: Sql, private readonly userId: string) {}

  loadCatalog(): Promise<Catalog> { return loadCatalog(this.sql); }

  async resolveVersion(organizationId: string, code: string, fiscalYear: number): Promise<VersionInfo | null> {
    return withUser(this.sql, this.userId, async (tx) => {
      const rows = code === 'approved'
        ? await tx<VRow[]>`
            select v.* from core.budget_versions v
            join gold.consolidation_runs r on r.budget_version_id = v.id and r.status = 'published'
            where v.organization_id = ${organizationId} and v.fiscal_year = ${fiscalYear} and v.kind = 'budget'
            order by r.published_at desc limit 1`
        : await tx<VRow[]>`select * from core.budget_versions
            where organization_id = ${organizationId} and code = ${code} and fiscal_year = ${fiscalYear}`;
      const v = rows[0];
      return v ? { id: v.id, code: v.code, name: v.name, kind: v.kind, fiscalYear: v.fiscal_year, rateScenario: v.rate_scenario,
        includesBalanceSheet: v.includes_balance_sheet } : null;
    });
  }

  async resolveRun(organizationId: string, versionId: string): Promise<RunInfo | null> {
    return withUser(this.sql, this.userId, async (tx) => {
      const [r] = await tx<Array<{ id: string; status: string; budget_version_id: string; presentation_currency: string; finished_at: string | null;
        inputs_hash: string | null }>>`
        select id, status, budget_version_id, presentation_currency, finished_at, inputs_hash from gold.consolidation_runs
        where organization_id = ${organizationId} and budget_version_id = ${versionId}
          and status in ('published', 'approved', 'ready_for_review')
        order by (status = 'published') desc, (status = 'approved') desc, created_at desc limit 1`;
      return r ? { id: r.id, status: r.status, versionId: r.budget_version_id, presentationCurrency: r.presentation_currency,
        finishedAt: r.finished_at, inputsHash: r.inputs_hash } : null;
    });
  }

  async loadFinancials(runId: string): Promise<FinancialRow[]> {
    return withUser(this.sql, this.userId, async (tx) => {
      const rows = await tx<Array<{ company_id: string; account_id: string; period_code: string; t: string; e: string; c: string; a: string; total: string }>>`
        select company_id, account_id, period_code, translated_amount::text as t, elimination_amount::text as e, cta_amount::text as c,
               adjustment_amount::text as a, total_amount::text as total
        from gold.consolidated_financials where run_id = ${runId}`;
      return rows.map((r) => ({ companyId: r.company_id, accountId: r.account_id, periodCode: r.period_code, translated: trimDecimal(r.t),
        elimination: trimDecimal(r.e), cta: trimDecimal(r.c), adjustment: trimDecimal(r.a), total: trimDecimal(r.total) }));
    });
  }

  async loadBridgeEntries(runId: string): Promise<BridgeEntry[]> {
    return withUser(this.sql, this.userId, async (tx) => {
      const rows = await tx<Array<{ company_id: string; account_id: string; code: string; category: BridgeEntry['category']; period_code: string;
        entry_type: BridgeEntry['entryType']; local_amount: string | null; local_currency: string | null; rate_type: BridgeEntry['rateType'];
        group_amount: string }>>`
        select e.company_id, e.account_id, a.code, a.category, e.period_code, e.entry_type, e.local_amount::text as local_amount,
               e.local_currency, e.rate_type, e.group_amount::text as group_amount
        from gold.consolidation_entries e join silver.accounts a on a.id = e.account_id
        where e.run_id = ${runId} and a.statement = 'PL'`;
      return rows.map((r) => ({ companyId: r.company_id, accountId: r.account_id, accountCode: r.code, category: r.category,
        periodCode: r.period_code, entryType: r.entry_type, localAmount: r.local_amount, localCurrency: r.local_currency?.trim() ?? null,
        rateType: r.rate_type, groupAmount: r.group_amount }));
    });
  }

  async loadRatesApplied(runId: string) {
    const [r] = await this.sql<Array<{ rates_applied: Array<{ fromCurrency: string; rateType: string; periodCode: string | null; rate: string }> }>>`
      select rates_applied from gold.consolidation_runs where id = ${runId}`;
    return r?.rates_applied ?? [];
  }

  loadAccounts(organizationId: string) { return loadAccounts(this.sql, organizationId); }

  /** Solo las empresas visibles por RLS para el usuario. */
  loadCompanies(organizationId: string) {
    return withUser(this.sql, this.userId, (tx) => loadCompanies(tx, organizationId));
  }

  loadParameters(organizationId: string, fiscalYear: number) { return loadParameters(this.sql, organizationId, fiscalYear); }

  async logQuery(e: Parameters<FinancialQueryAdapter['logQuery']>[0]): Promise<string> {
    const [r] = await this.sql<Array<{ id: string }>>`
      insert into semantic.query_executions (organization_id, user_id, source, request, run_ids, row_count, duration_ms, status, error)
      values (${e.organizationId}, ${e.userId}, ${e.source}, ${JSON.stringify(e.request)}::text::jsonb, ${e.runIds}::uuid[], ${e.rowCount},
              ${e.durationMs}, ${e.status}, ${e.error ?? null})
      returning id`;
    for (const runId of e.runIds) {
      await this.sql`insert into audit.data_lineage (organization_id, from_type, from_id, to_type, to_id, relation)
        values (${e.organizationId}, 'query_execution', ${r!.id}, 'consolidation_run', ${runId}, 'reads')`;
    }
    return r!.id;
  }
}

interface VRow {
  id: string; code: string; name: string; kind: 'budget' | 'forecast' | 'actual'; fiscal_year: number; rate_scenario: string;
  includes_balance_sheet: boolean;
}
