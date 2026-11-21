import type { Sql } from '@nexora/database';
import { validate } from '@nexora/validation-engine';
import {
  loadAcceptances, loadAccounts, loadApprovedRates, loadCompanies, loadParameters, loadRules, loadVersion, loadVersionLines,
} from './loaders.js';

export interface ValidationSummary {
  run_id: string;
  rules_version: string;
  lines: number;
  open_critical: number;
  open_warning: number;
  open_informational: number;
  new_issues: number;
  auto_resolved: number;
}

/**
 * Ejecuta todas las reglas sobre una versión y persiste el ciclo de vida de las incidencias:
 *  - nuevas → open; reproducidas → se mantienen (accepted/excluded no se reabren);
 *  - abiertas que ya no se reproducen → resolved ("no se reproduce en la revalidación").
 * Operación privilegiada: el llamador debe haber autorizado al usuario.
 */
export async function validateVersion(sql: Sql, organizationId: string, versionId: string, userId: string | null): Promise<ValidationSummary> {
  const version = await loadVersion(sql, organizationId, versionId);
  const [org] = await sql<Array<{ presentation_currency: string }>>`select presentation_currency from core.organizations where id = ${organizationId}`;
  const [companies, accounts, rates, params, rules, acceptances, lines] = await Promise.all([
    loadCompanies(sql, organizationId), loadAccounts(sql, organizationId), loadApprovedRates(sql, organizationId, version.rate_scenario),
    loadParameters(sql, organizationId, version.fiscal_year), loadRules(sql), loadAcceptances(sql, versionId), loadVersionLines(sql, versionId),
  ]);
  const ca = await sql<Array<{ company_id: string; code: string }>>`
    select ca.company_id, ca.code from silver.company_accounts ca join core.companies c on c.id = ca.company_id
    where c.organization_id = ${organizationId}`;
  const maps = await sql<Array<{ company_id: string; company_account_code: string; account_id: string }>>`
    select company_id, company_account_code, account_id from silver.account_mappings
    where organization_id = ${organizationId} and status = 'approved'`;
  const currencies = await sql<Array<{ code: string }>>`select code from core.currencies`;
  const withData = await sql<Array<{ company_id: string }>>`
    select distinct company_id from bronze.ingestion_batches where budget_version_id = ${versionId} and status = 'processed'`;

  const companyAccounts = new Map<string, Set<string>>();
  for (const r of ca) {
    const s = companyAccounts.get(r.company_id) ?? new Set<string>();
    s.add(r.code);
    companyAccounts.set(r.company_id, s);
  }
  const out = validate(lines, {
    fiscalYear: version.fiscal_year, presentationCurrency: org!.presentation_currency, rateScenario: version.rate_scenario,
    companies, companyAccounts, mappings: new Map(maps.map((m) => [`${m.company_id}|${m.company_account_code}`, m.account_id])),
    accounts, currencies: new Set(currencies.map((c) => c.code.trim())), rates, acceptances, parameters: params, rules,
    companiesWithData: new Set(withData.map((w) => w.company_id)),
  });

  return sql.begin(async (tx) => {
    const [run] = await tx<Array<{ id: string }>>`
      insert into silver.validation_runs (organization_id, budget_version_id, rules_version, created_by)
      values (${organizationId}, ${versionId}, ${out.rulesVersion}, ${userId}) returning id`;
    const runId = run!.id;

    // Resolución de cuentas y estado de líneas
    const criticalLines = new Set(out.issues.filter((i) => i.severity === 'critical' && i.lineId).map((i) => i.lineId!));
    const updates = lines.map((l) => ({
      id: l.id, account_id: out.resolvedAccounts.get(l.id) ?? null, status: criticalLines.has(l.id) ? 'invalid' : 'valid',
    }));
    for (let i = 0; i < updates.length; i += 1000) {
      const chunk = updates.slice(i, i + 1000);
      await tx`
        update silver.normalized_budget_lines l
        set account_id = u.account_id::uuid, status = u.status
        from jsonb_to_recordset(${JSON.stringify(chunk)}::text::jsonb) as u(id uuid, account_id text, status text)
        where l.id = u.id and (l.account_id is distinct from u.account_id::uuid or l.status <> u.status)`;
    }

    // Ciclo de vida de incidencias
    const existing = await tx<Array<{ id: string; fingerprint: string; status: string }>>`
      select id, fingerprint, status from silver.validation_issues where budget_version_id = ${versionId}`;
    const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
    const reproduced = new Set<string>();
    const fresh = [];
    for (const i of out.issues) {
      reproduced.add(i.fingerprint);
      const e = byFp.get(i.fingerprint);
      if (!e) {
        fresh.push({
          organization_id: organizationId, budget_version_id: versionId, company_id: i.companyId, batch_id: i.batchId,
          normalized_line_id: i.lineId, raw_row_id: i.rawRowId, rule_code: i.ruleCode, rule_version: i.ruleVersion, severity: i.severity,
          issue_type: i.issueType, description: i.description, found_value: i.foundValue, expected_value: i.expectedValue,
          fingerprint: i.fingerprint, first_run_id: runId, last_run_id: runId,
        });
      }
    }
    if (fresh.length) await tx`insert into silver.validation_issues ${tx(fresh)}`;
    const keep = out.issues.filter((i) => byFp.has(i.fingerprint)).map((i) => i.fingerprint);
    if (keep.length) {
      await tx`update silver.validation_issues set last_run_id = ${runId},
          status = case when status = 'resolved' then 'open' else status end,
          resolution = case when status = 'resolved' then null else resolution end
        where budget_version_id = ${versionId} and fingerprint = any(${keep}::text[])`;
    }
    const gone = existing.filter((e) => e.status === 'open' && !reproduced.has(e.fingerprint)).map((e) => e.id);
    if (gone.length) {
      await tx`update silver.validation_issues
        set status = 'resolved', resolution = coalesce(resolution, 'No se reproduce en la revalidación'), resolved_at = now(),
            resolved_by = coalesce(resolved_by, ${userId}::uuid), last_run_id = ${runId}
        where id = any(${gone}::uuid[])`;
    }

    // Conciliación intercompañía: nueva instantánea ligada a esta corrida (las anteriores se conservan para trazabilidad)
    if (out.icMatches.length) {
      await tx`insert into silver.intercompany_matches ${tx(out.icMatches.map((m) => ({
        organization_id: organizationId, budget_version_id: versionId, validation_run_id: runId, ic_reference: m.icReference,
        period_code: m.periodCode, seller_company_id: m.sellerCompanyId, buyer_company_id: m.buyerCompanyId,
        seller_line_id: m.sellerLineId, buyer_line_id: m.buyerLineId, seller_amount: m.sellerAmount, buyer_amount: m.buyerAmount,
        difference: m.difference, tolerance: m.tolerance, status: m.status,
      })))}`;
    }

    const counts = await tx<Array<{ severity: string; n: number }>>`
      select severity, count(*)::int as n from silver.validation_issues
      where budget_version_id = ${versionId} and status = 'open' group by severity`;
    const c = (s: string) => counts.find((x) => x.severity === s)?.n ?? 0;
    const summary: ValidationSummary = {
      run_id: runId, rules_version: out.rulesVersion, lines: lines.length, open_critical: c('critical'), open_warning: c('warning'),
      open_informational: c('informational'), new_issues: fresh.length, auto_resolved: gone.length,
    };
    await tx`update silver.validation_runs set finished_at = now(), summary = ${JSON.stringify(summary)}::text::jsonb where id = ${runId}`;
    return summary;
  }) as Promise<ValidationSummary>;
}
