import type { Db } from '@nexora/database';
import type { Account, Company, IcAcceptance, Rate } from '@nexora/financial-engine';
import type { RuleDef, VLine } from '@nexora/validation-engine';
import { notFound } from '../errors.js';

export interface VersionRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  kind: 'budget' | 'forecast' | 'actual';
  fiscal_year: number;
  rate_scenario: string;
  includes_balance_sheet: boolean;
}

export async function loadVersion(sql: Db, organizationId: string, versionId: string): Promise<VersionRow> {
  const [v] = await sql<VersionRow[]>`select id, organization_id, code, name, kind, fiscal_year, rate_scenario, includes_balance_sheet
    from core.budget_versions where id = ${versionId} and organization_id = ${organizationId}`;
  if (!v) throw notFound('Versión presupuestaria no encontrada');
  return v;
}

export async function loadCompanies(sql: Db, organizationId: string): Promise<Company[]> {
  const rows = await sql<Array<{ id: string; code: string; name: string; country_code: string; functional_currency: string }>>`
    select id, code, name, country_code, functional_currency from core.companies
    where organization_id = ${organizationId} and is_active order by code`;
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, countryCode: r.country_code, functionalCurrency: r.functional_currency }));
}

export async function loadAccounts(sql: Db, organizationId: string): Promise<Account[]> {
  const rows = await sql<Array<{ id: string; code: string; name: string; statement: 'PL' | 'BS'; category: Account['category'];
    is_intercompany: boolean; rate_type: Account['rateType']; consolidation_only: boolean }>>`
    select id, code, name, statement, category, is_intercompany, rate_type, consolidation_only
    from silver.accounts where organization_id = ${organizationId} order by code`;
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, statement: r.statement, category: r.category,
    isIntercompany: r.is_intercompany, rateType: r.rate_type, consolidationOnly: r.consolidation_only }));
}

export async function loadApprovedRates(sql: Db, organizationId: string, scenario: string): Promise<Rate[]> {
  const rows = await sql<Array<{ id: string; from_currency: string; to_currency: string; period_code: string | null;
    rate_type: Rate['rateType']; scenario: string; rate: string }>>`
    select id, from_currency, to_currency, period_code, rate_type, scenario, rate::text as rate
    from silver.exchange_rates
    where organization_id = ${organizationId} and scenario = ${scenario} and status = 'approved'
    order by version desc`;
  // Si existen varias versiones aprobadas de la misma tasa, prevalece la más reciente (orden desc)
  const seen = new Set<string>();
  const out: Rate[] = [];
  for (const r of rows) {
    const k = `${r.from_currency}|${r.to_currency}|${r.rate_type}|${r.period_code ?? '-'}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: r.id, fromCurrency: r.from_currency, toCurrency: r.to_currency, periodCode: r.period_code, rateType: r.rate_type,
      scenario: r.scenario, rate: r.rate });
  }
  return out;
}

export async function loadParameters(sql: Db, organizationId: string, fiscalYear: number): Promise<Record<string, string>> {
  const rows = await sql<Array<{ code: string; value: string }>>`
    select code, value::text as value from core.financial_parameters
    where organization_id = ${organizationId} and fiscal_year = ${fiscalYear} and status = 'approved'`;
  return Object.fromEntries(rows.map((r) => [r.code, r.value.replace(/0+$/, '').replace(/\.$/, '')]));
}

export async function loadAcceptances(sql: Db, versionId: string): Promise<IcAcceptance[]> {
  const rows = await sql<Array<{ ic_reference: string; seller_line_hash: string; buyer_line_hash: string }>>`
    select ic_reference, seller_line_hash, buyer_line_hash from silver.intercompany_acceptances where budget_version_id = ${versionId}`;
  return rows.map((r) => ({ icReference: r.ic_reference, sellerLineHash: r.seller_line_hash, buyerLineHash: r.buyer_line_hash }));
}

export async function loadRules(sql: Db): Promise<RuleDef[]> {
  const rows = await sql<Array<{ code: string; severity: RuleDef['severity']; rule_version: number; is_active: boolean }>>`
    select code, severity, rule_version, is_active from silver.validation_rules`;
  return rows.map((r) => ({ code: r.code, severity: r.severity, ruleVersion: r.rule_version, isActive: r.is_active }));
}

/** Líneas vigentes de la versión: lotes procesados (no reemplazados) y líneas no excluidas. */
export async function loadVersionLines(sql: Db, versionId: string): Promise<VLine[]> {
  const rows = await sql<Array<{ id: string; company_id: string; batch_id: string; raw_row_id: string; row_number: number;
    account_code: string | null; period_raw: string | null; period_code: string | null; amount_raw: string | null; amount: string | null;
    currency: string | null; counterparty_code: string | null; ic_reference: string | null; line_hash: string }>>`
    select l.id, l.company_id, l.batch_id, l.raw_row_id, l.row_number, l.account_code, l.period_raw, l.period_code, l.amount_raw,
           l.amount::text as amount, l.currency, l.counterparty_code, l.ic_reference, l.line_hash
    from silver.normalized_budget_lines l
    join bronze.ingestion_batches b on b.id = l.batch_id and b.status = 'processed'
    where l.budget_version_id = ${versionId} and l.status <> 'excluded'
    order by l.company_id, l.row_number`;
  return rows.map((r) => ({
    id: r.id, companyId: r.company_id, batchId: r.batch_id, rawRowId: r.raw_row_id, rowNumber: r.row_number, accountCode: r.account_code,
    periodRaw: r.period_raw, periodCode: r.period_code, amountRaw: r.amount_raw, amount: r.amount === null ? null : trimDecimal(r.amount),
    currency: r.currency, counterpartyCode: r.counterparty_code, icReference: r.ic_reference, lineHash: r.line_hash,
  }));
}

export function trimDecimal(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
