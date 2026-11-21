import { CreateMappingRequest, CreateRateRequest, ResolutionAction } from '@nexora/shared';
import { D } from '@nexora/financial-engine';
import { lineHash } from '@nexora/validation-engine';
import { approvalEvent, audit, requireCompany, requirePerm, type AuthContext, type Deps } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { trimDecimal } from './loaders.js';
import { validateVersion } from './validation.js';

interface IssueRow {
  id: string;
  organization_id: string;
  budget_version_id: string;
  company_id: string | null;
  normalized_line_id: string | null;
  rule_code: string;
  severity: string;
  status: string;
  fingerprint: string;
  expected_value: string | null;
}

/** Aplica una acción de resolución autorizada. Los registros Bronze nunca se modifican. */
export async function resolveIssue(deps: Deps, ctx: AuthContext, issueId: string, raw: unknown) {
  const parsed = ResolutionAction.safeParse(raw);
  if (!parsed.success) throw badRequest('Acción inválida', parsed.error.issues);
  const action = parsed.data;
  const { sql } = deps;
  const [issue] = await sql<IssueRow[]>`select id, organization_id, budget_version_id, company_id, normalized_line_id, rule_code, severity,
      status, fingerprint, expected_value
    from silver.validation_issues where id = ${issueId} and organization_id = ${ctx.organizationId}`;
  if (!issue) throw notFound('Incidencia no encontrada');
  if (issue.company_id) requireCompany(ctx, issue.company_id);
  if (issue.status !== 'open') throw conflict(`La incidencia ya está ${issue.status}`);

  switch (action.action) {
    case 'exclude_line': {
      requirePerm(ctx, 'quality.resolve');
      if (!issue.normalized_line_id) throw badRequest('La incidencia no está asociada a un registro');
      await sql.begin(async (tx) => {
        await tx`update silver.normalized_budget_lines set status = 'excluded', exclusion_reason = ${action.reason},
            corrections = corrections || ${JSON.stringify([{ action: 'exclude', by: ctx.userId, at: new Date().toISOString(), reason: action.reason }])}::text::jsonb
          where id = ${issue.normalized_line_id}`;
        await tx`update silver.validation_issues set status = 'excluded', resolution = ${action.reason}, resolved_by = ${ctx.userId},
            resolved_at = now() where id = ${issue.id}`;
        await audit(tx, ctx, 'issue.exclude_line', 'validation_issue', issue.id, { line: issue.normalized_line_id, reason: action.reason });
      });
      break;
    }
    case 'correct_field': {
      requirePerm(ctx, 'quality.resolve');
      if (action.field === 'amount') requirePerm(ctx, 'quality.approve'); // un importe solo se corrige con aprobación
      if (!issue.normalized_line_id) throw badRequest('La incidencia no está asociada a un registro');
      const value = await validateCorrection(deps, ctx, action.field, action.value, issue);
      await sql.begin(async (tx) => {
        const [line] = await tx<Array<Record<string, string | null> & { raw_row_id: string; company_id: string }>>`
          select raw_row_id, company_id, account_code, period_code, amount::text as amount, currency, counterparty_code, ic_reference
          from silver.normalized_budget_lines where id = ${issue.normalized_line_id}`;
        if (!line) throw notFound('Registro no encontrado');
        const before = line[action.field] ?? null;
        const next = { ...line, [action.field]: value };
        const hash = lineHash({
          rawRowId: line.raw_row_id, companyId: line.company_id, accountCode: next.account_code ?? null, periodCode: next.period_code ?? null,
          amount: next.amount ? trimDecimal(next.amount) : null, currency: next.currency ?? null, counterpartyCode: next.counterparty_code ?? null,
          icReference: next.ic_reference ?? null,
        });
        const correction = [{ action: 'correct', field: action.field, from: before, to: value, by: ctx.userId, at: new Date().toISOString(), reason: action.reason }];
        await tx`update silver.normalized_budget_lines set ${tx({ [action.field]: value })}, line_hash = ${hash},
            corrections = corrections || ${JSON.stringify(correction)}::text::jsonb
          where id = ${issue.normalized_line_id}`;
        await tx`update silver.validation_issues set status = 'resolved', resolution = ${`Corrección de ${action.field}: ${before ?? '∅'} → ${value ?? '∅'}. ${action.reason}`},
            resolved_by = ${ctx.userId}, resolved_at = now() where id = ${issue.id}`;
        await audit(tx, ctx, 'issue.correct_field', 'validation_issue', issue.id, { field: action.field, from: before, to: value, reason: action.reason });
        if (action.field === 'amount') {
          await approvalEvent(tx, ctx, 'normalized_line', issue.normalized_line_id!, 'approve_amount_correction', before, value, action.reason);
        }
      });
      break;
    }
    case 'accept': {
      requirePerm(ctx, 'quality.approve');
      if (issue.severity === 'critical') throw forbidden('Las incidencias críticas no pueden aceptarse: deben corregirse o excluirse');
      await sql.begin(async (tx) => {
        await tx`update silver.validation_issues set status = 'accepted', resolution = ${action.reason}, resolved_by = ${ctx.userId},
            resolved_at = now() where id = ${issue.id}`;
        await approvalEvent(tx, ctx, 'validation_issue', issue.id, 'accept_warning', 'open', 'accepted', action.reason);
      });
      break;
    }
    case 'accept_ic_difference': {
      requirePerm(ctx, 'quality.approve');
      if (issue.rule_code !== 'IC_MISMATCH') throw badRequest('Solo aplica a descuadres intercompañía');
      const ref = issue.fingerprint.replace(/^IC_MISMATCH\|/, '');
      const [m] = await sql<Array<{ seller_line_id: string; buyer_line_id: string }>>`
        select seller_line_id, buyer_line_id from silver.current_intercompany_matches
        where budget_version_id = ${issue.budget_version_id} and ic_reference = ${ref} and status = 'mismatch'`;
      if (!m) throw conflict('La conciliación cambió; revalide antes de aceptar');
      const hashes = await sql<Array<{ id: string; line_hash: string }>>`
        select id, line_hash from silver.normalized_budget_lines where id in (${m.seller_line_id}, ${m.buyer_line_id})`;
      const h = (id: string) => hashes.find((x) => x.id === id)!.line_hash;
      await sql.begin(async (tx) => {
        await tx`insert into silver.intercompany_acceptances (organization_id, budget_version_id, ic_reference, seller_line_hash,
            buyer_line_hash, reason, approved_by)
          values (${ctx.organizationId}, ${issue.budget_version_id}, ${ref}, ${h(m.seller_line_id)}, ${h(m.buyer_line_id)}, ${action.reason}, ${ctx.userId})
          on conflict (budget_version_id, ic_reference) do update set seller_line_hash = excluded.seller_line_hash,
            buyer_line_hash = excluded.buyer_line_hash, reason = excluded.reason, approved_by = excluded.approved_by, approved_at = now()`;
        await tx`update silver.validation_issues set status = 'accepted', resolution = ${`Diferencia IC aceptada: ${action.reason}`},
            resolved_by = ${ctx.userId}, resolved_at = now() where id = ${issue.id}`;
        await approvalEvent(tx, ctx, 'intercompany', ref, 'accept_ic_difference', 'mismatch', 'accepted_difference', action.reason);
      });
      break;
    }
  }
  const summary = await validateVersion(sql, ctx.organizationId, issue.budget_version_id, ctx.userId);
  return { issue_id: issue.id, validation: summary };
}

async function validateCorrection(deps: Deps, ctx: AuthContext, field: string, value: string, issue: IssueRow): Promise<string | null> {
  const v = value.trim();
  switch (field) {
    case 'currency': {
      const [c] = await deps.sql`select code from core.currencies where code = ${v.toUpperCase()}`;
      if (!c) throw badRequest(`La moneda ${v} no existe en el catálogo`);
      return v.toUpperCase();
    }
    case 'period_code':
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw badRequest('Periodo inválido (AAAA-MM)');
      return v;
    case 'counterparty_code': {
      if (v === '') return null;
      const [c] = await deps.sql`select id from core.companies where organization_id = ${ctx.organizationId} and code = ${v}`;
      if (!c) throw badRequest(`La empresa ${v} no pertenece al grupo`);
      return v;
    }
    case 'account_code':
      if (!v) throw badRequest('Código de cuenta vacío');
      return v;
    case 'amount': {
      if (v === 'abs') {
        if (!issue.expected_value) throw badRequest('No hay un valor esperado determinable');
        return issue.expected_value;
      }
      if (!/^-?\d+(\.\d{1,6})?$/.test(v)) throw badRequest('Importe inválido');
      return D(v).toFixed();
    }
  }
  throw badRequest('Campo no corregible');
}

export async function createAccountMapping(deps: Deps, ctx: AuthContext, raw: unknown) {
  requirePerm(ctx, 'mapping.manage');
  const p = CreateMappingRequest.safeParse(raw);
  if (!p.success) throw badRequest('Solicitud inválida', p.error.issues);
  requireCompany(ctx, p.data.company_id);
  const { sql } = deps;
  const [acct] = await sql<Array<{ id: string; consolidation_only: boolean }>>`
    select id, consolidation_only from silver.accounts where organization_id = ${ctx.organizationId} and code = ${p.data.account_code}`;
  if (!acct) throw badRequest('Cuenta corporativa inexistente');
  if (acct.consolidation_only) throw badRequest('Las cuentas exclusivas de consolidación no admiten mapeo');
  const [m] = await sql<Array<{ id: string }>>`
    insert into silver.account_mappings (organization_id, company_id, company_account_code, account_id, status, approved_by, approved_at, created_by)
    values (${ctx.organizationId}, ${p.data.company_id}, ${p.data.company_account_code}, ${acct.id}, 'approved', ${ctx.userId}, now(), ${ctx.userId})
    on conflict (company_id, company_account_code) do update set account_id = excluded.account_id, status = 'approved',
      approved_by = excluded.approved_by, approved_at = now()
    returning id`;
  await approvalEvent(sql, ctx, 'account_mapping', m!.id, 'approve_mapping', null, 'approved',
    `${p.data.company_account_code} → ${p.data.account_code}`);
  const versions = await sql<Array<{ budget_version_id: string }>>`
    select distinct budget_version_id from silver.validation_issues
    where company_id = ${p.data.company_id} and rule_code in ('UNMAPPED_ACCOUNT', 'UNKNOWN_ACCOUNT') and status = 'open'`;
  const results = [];
  for (const v of versions) results.push(await validateVersion(sql, ctx.organizationId, v.budget_version_id, ctx.userId));
  return { mapping_id: m!.id, revalidated: results };
}

export async function createExchangeRate(deps: Deps, ctx: AuthContext, raw: unknown) {
  requirePerm(ctx, 'rates.manage');
  const p = CreateRateRequest.safeParse(raw);
  if (!p.success) throw badRequest('Solicitud inválida', p.error.issues);
  const r = p.data;
  if (r.rate_type !== 'historical' && !r.period_code) throw badRequest('Las tasas promedio y de cierre requieren periodo');
  const { sql } = deps;
  const [prev] = await sql<Array<{ version: number }>>`
    select max(version) as version from silver.exchange_rates where organization_id = ${ctx.organizationId}
      and from_currency = ${r.from_currency} and to_currency = ${r.to_currency} and coalesce(period_code, '-') = ${r.period_code ?? '-'}
      and rate_type = ${r.rate_type} and scenario = ${r.scenario}`;
  const version = (prev?.version ?? 0) + 1;
  const [row] = await sql<Array<{ id: string }>>`
    insert into silver.exchange_rates (organization_id, from_currency, to_currency, period_code, rate_type, scenario, version, rate, source,
      status, approved_by, approved_at, created_by)
    values (${ctx.organizationId}, ${r.from_currency}, ${r.to_currency}, ${r.period_code}, ${r.rate_type}, ${r.scenario}, ${version}, ${r.rate},
      ${r.source}, 'approved', ${ctx.userId}, now(), ${ctx.userId})
    returning id`;
  await approvalEvent(sql, ctx, 'exchange_rate', row!.id, 'approve_rate', null, 'approved',
    `${r.from_currency}/${r.to_currency} ${r.rate_type} ${r.period_code ?? ''} ${r.scenario} = ${r.rate} (${r.source})`);
  const versions = await sql<Array<{ id: string }>>`
    select id from core.budget_versions where organization_id = ${ctx.organizationId} and rate_scenario = ${r.scenario}
      and exists (select 1 from bronze.ingestion_batches b where b.budget_version_id = budget_versions.id and b.status = 'processed')`;
  const results = [];
  for (const v of versions) results.push(await validateVersion(sql, ctx.organizationId, v.id, ctx.userId));
  return { rate_id: row!.id, version, revalidated: results };
}
