import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { createAdminClient, createSql, SupabaseStorageAdapter, withUser } from '@nexora/database';
import { executeSemanticQuery, SemanticError } from '@nexora/semantic-engine';
import { AiProviderError } from '@nexora/ai-engine';
import { authenticate, requireAllCompanies, requirePerm, type AuthContext, type Deps } from './context.js';
import type { Env } from './env.js';
import { badRequest, HttpError } from './errors.js';
import { createBatch, uploadSourceFile } from './services/ingestion.js';
import { createAccountMapping, createExchangeRate, resolveIssue } from './services/quality.js';
import { validateVersion } from './services/validation.js';
import { compareRuns, getRun, runConsolidation, transitionRun } from './services/consolidation.js';
import { loadCatalog, PgFinancialQueryAdapter } from './services/semantic-adapter.js';
import { createScenario, lineChain, listEntries, listScenarios, metricLineage, varianceAnalysis } from './services/analytics.js';
import {
  applyDashboardActions, archiveDashboard, confirmPendingChange, createDashboard, duplicateDashboard, getDashboard, listDashboards,
  listVersions, restoreVersion, shareDashboard, widgetData,
} from './services/dashboards.js';
import { agentContext, askAnalyst, dashboardInstruction, provider } from './services/ai.js';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext }
}

const Uuid = z.string().uuid();
const uuidParam = (v: unknown, name = 'id') => {
  const p = Uuid.safeParse(v);
  if (!p.success) throw badRequest(`${name} inválido`);
  return p.data;
};

export function createDeps(env: Env): Deps {
  const admin = createAdminClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  return { env, sql: createSql(env.DATABASE_URL), admin, storage: new SupabaseStorageAdapter(admin) };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.apiKey'], censor: '[redactado]' },
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  await app.register(cors, { origin: [...deps.env.APP_URL.split(',').map((o) => o.trim()), 'http://localhost:3000'], credentials: false,
    allowedHeaders: ['authorization', 'content-type', 'x-organization-id'], methods: ['GET', 'POST', 'PATCH', 'DELETE'] });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof SemanticError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof AiProviderError) return reply.status(502).send({ error: { code: 'AI_PROVIDER', message: err.message } });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Datos inválidos', details: err.issues } });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === 'P0001') return reply.status(409).send({ error: { code: 'INTEGRITY', message: (err as Error).message } });
    if ((err as { statusCode?: number }).statusCode === 413) return reply.status(413).send({ error: { code: 'TOO_LARGE', message: 'Archivo demasiado grande' } });
    req.log.error({ err }, 'Error no controlado');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Error interno. Consulte el registro con el identificador de solicitud.', request_id: req.id } });
  });

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    req.auth = await authenticate(deps, req.headers.authorization, req.headers['x-organization-id'] as string | undefined);
  });

  const { sql } = deps;
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const b = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const qctx = (a: AuthContext, source: 'ui' | 'dashboard' = 'ui') => ({ organizationId: a.organizationId, userId: a.userId,
    hasAllCompanies: a.allCompanies, accessibleCompanyIds: a.companyIds, source });

  app.get('/api/health', async () => {
    await sql`select 1`;
    return { status: 'ok', ai_provider: provider(deps).name, time: new Date().toISOString() };
  });

  // ---------------------------------------------------------------- identidad y referencia
  app.get('/api/me', async (req) => {
    const a = req.auth;
    const [p] = await sql`select full_name, email from core.users_profiles where user_id = ${a.userId}`;
    return { user_id: a.userId, email: a.email, full_name: p?.full_name ?? a.email, organization_id: a.organizationId, role: a.role,
      presentation_currency: a.presentationCurrency, all_companies: a.allCompanies, permissions: [...a.permissions].sort(),
      memberships: a.memberships, ai_provider: provider(deps).name };
  });

  app.get('/api/reference', async (req) => {
    const a = req.auth;
    return withUser(sql, a.userId, async (tx) => {
      const companies = await tx`select id, code, name, country_code, functional_currency from core.companies
        where organization_id = ${a.organizationId} order by code`;
      const versions = await tx`select v.id, v.code, v.name, v.kind, v.fiscal_year, v.rate_scenario, v.includes_balance_sheet,
          (select jsonb_build_object('id', r.id, 'status', r.status, 'created_at', r.created_at, 'published_at', r.published_at)
           from gold.consolidation_runs r where r.budget_version_id = v.id order by r.created_at desc limit 1) as latest_run,
          (select r.id from gold.consolidation_runs r where r.budget_version_id = v.id and r.status = 'published') as published_run_id
        from core.budget_versions v where v.organization_id = ${a.organizationId} order by v.fiscal_year desc, v.code`;
      const accounts = await tx`select id, code, name, statement, category, is_intercompany, rate_type, consolidation_only
        from silver.accounts where organization_id = ${a.organizationId} order by code`;
      const currencies = await tx`select code, name from core.currencies order by code`;
      return { companies, versions, accounts, currencies };
    });
  });

  // ---------------------------------------------------------------- Data Hub
  app.post('/api/data-hub/upload', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Archivo requerido');
    const companyId = uuidParam((file.fields.company_id as { value?: string } | undefined)?.value, 'company_id');
    const bytes = new Uint8Array(await file.toBuffer());
    return uploadSourceFile(deps, req.auth, { companyId, fileName: file.filename, bytes });
  });
  app.post('/api/data-hub/batches', async (req) => createBatch(deps, req.auth, req.body, { wait: q(req).wait === '1' }));
  app.get('/api/data-hub/batches', async (req) => {
    requirePerm(req.auth, 'data.read');
    const v = q(req).version_id ? uuidParam(q(req).version_id, 'version_id') : null;
    return withUser(sql, req.auth.userId, (tx) => tx`
      select b.id, b.status, b.row_count, b.processed_rows, b.error, b.created_at, b.finished_at, c.code as company_code, c.name as company_name,
             v.code as version_code, f.original_name, f.sha256, f.size_bytes, p.full_name as created_by
      from bronze.ingestion_batches b join core.companies c on c.id = b.company_id join core.budget_versions v on v.id = b.budget_version_id
      join bronze.source_files f on f.id = b.source_file_id left join core.users_profiles p on p.user_id = b.created_by
      where b.organization_id = ${req.auth.organizationId} ${v ? tx`and b.budget_version_id = ${v}` : tx``}
      order by b.created_at desc limit 200`);
  });
  app.get('/api/data-hub/batches/:id', async (req) => {
    const id = uuidParam((req.params as { id: string }).id);
    const [row] = await withUser(sql, req.auth.userId, (tx) => tx`select * from bronze.ingestion_batches where id = ${id}`);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lote no encontrado');
    return row;
  });

  // ---------------------------------------------------------------- Calidad, homologación y tasas
  app.get('/api/quality/issues', async (req) => {
    requirePerm(req.auth, 'quality.review');
    const v = uuidParam(q(req).version_id, 'version_id');
    const status = q(req).status;
    return withUser(sql, req.auth.userId, (tx) => tx`
      select i.id, i.rule_code, r.name as rule_name, i.rule_version, i.severity, i.issue_type, i.description, i.found_value, i.expected_value,
             i.status, i.resolution, i.resolved_at, i.created_at, i.updated_at, i.normalized_line_id, i.raw_row_id, c.code as company_code,
             l.row_number, l.account_code, l.period_raw, l.amount_raw, f.original_name as file_name, p.full_name as resolved_by
      from silver.validation_issues i join silver.validation_rules r on r.code = i.rule_code
      left join core.companies c on c.id = i.company_id
      left join silver.normalized_budget_lines l on l.id = i.normalized_line_id
      left join bronze.ingestion_batches b on b.id = l.batch_id left join bronze.source_files f on f.id = b.source_file_id
      left join core.users_profiles p on p.user_id = i.resolved_by
      where i.budget_version_id = ${v} ${status ? tx`and i.status = ${status}` : tx``}
      order by (i.status = 'open') desc, case i.severity when 'critical' then 0 when 'warning' then 1 else 2 end, c.code, l.row_number`);
  });
  app.post('/api/quality/issues/:id/resolve', async (req) => resolveIssue(deps, req.auth, uuidParam((req.params as { id: string }).id), req.body));
  app.post('/api/quality/validate', async (req) => {
    requirePerm(req.auth, 'quality.review');
    requireAllCompanies(req.auth);
    return validateVersion(sql, req.auth.organizationId, uuidParam(b(req).version_id, 'version_id'), req.auth.userId);
  });
  app.get('/api/quality/ic-matches', async (req) => {
    const v = uuidParam(q(req).version_id, 'version_id');
    return withUser(sql, req.auth.userId, (tx) => tx`
      select m.ic_reference, m.period_code, s.code as seller, bu.code as buyer, m.seller_amount::text, m.buyer_amount::text,
             m.difference::text, m.tolerance::text, m.status
      from silver.current_intercompany_matches m left join core.companies s on s.id = m.seller_company_id
      left join core.companies bu on bu.id = m.buyer_company_id
      where m.budget_version_id = ${v} order by (m.status <> 'matched') desc, m.ic_reference`);
  });
  app.post('/api/admin/account-mappings', async (req) => createAccountMapping(deps, req.auth, req.body));
  app.get('/api/admin/account-mappings', async (req) => {
    const c = uuidParam(q(req).company_id, 'company_id');
    return withUser(sql, req.auth.userId, (tx) => tx`
      select ca.code as company_account_code, ca.name as company_account_name, a.code as account_code, a.name as account_name, m.status
      from silver.company_accounts ca left join silver.account_mappings m on m.company_id = ca.company_id and m.company_account_code = ca.code
      left join silver.accounts a on a.id = m.account_id where ca.company_id = ${c} order by (m.id is null) desc, ca.code`);
  });
  app.get('/api/admin/rates', async (req) => withUser(sql, req.auth.userId, (tx) => tx`
    select r.id, r.from_currency, r.to_currency, r.period_code, r.rate_type, r.scenario, r.version, r.rate::text, r.source, r.status, r.approved_at
    from silver.exchange_rates r where r.organization_id = ${req.auth.organizationId}
      ${q(req).scenario ? tx`and r.scenario = ${q(req).scenario!}` : tx``}
    order by r.scenario, r.from_currency, r.rate_type, r.period_code nulls last, r.version desc`));
  app.post('/api/admin/rates', async (req) => createExchangeRate(deps, req.auth, req.body));
  app.get('/api/admin/members', async (req) => {
    requirePerm(req.auth, 'org.admin');
    return sql`select m.user_id, p.full_name, p.email, m.role_code, m.all_companies, m.status,
        coalesce((select array_agg(c.code order by c.code) from core.company_access a join core.companies c on c.id = a.company_id
          where a.user_id = m.user_id and a.organization_id = m.organization_id), '{}') as companies
      from core.organization_members m join core.users_profiles p on p.user_id = m.user_id
      where m.organization_id = ${req.auth.organizationId} order by p.full_name`;
  });
  app.get('/api/admin/parameters', async (req) => sql`select fiscal_year, code, value::text, description, status, approved_at
    from core.financial_parameters where organization_id = ${req.auth.organizationId} order by fiscal_year desc, code`);

  // ---------------------------------------------------------------- Consolidación
  app.post('/api/consolidation/runs', async (req) => runConsolidation(deps, req.auth, uuidParam(b(req).version_id, 'version_id')));
  app.get('/api/consolidation/runs', async (req) => withUser(sql, req.auth.userId, (tx) => tx`
    select r.id, r.status, r.inputs_hash, r.rules_version, r.engine_version, r.blocking_issues, r.summary, r.created_at, r.finished_at,
           r.approved_at, r.published_at, r.error, v.code as version_code, v.name as version_name, pc.full_name as created_by,
           pa.full_name as approved_by, pp.full_name as published_by
    from gold.consolidation_runs r join core.budget_versions v on v.id = r.budget_version_id
    left join core.users_profiles pc on pc.user_id = r.created_by left join core.users_profiles pa on pa.user_id = r.approved_by
    left join core.users_profiles pp on pp.user_id = r.published_by
    where r.organization_id = ${req.auth.organizationId}
      ${q(req).version_id ? tx`and r.budget_version_id = ${uuidParam(q(req).version_id, 'version_id')}` : tx``}
    order by r.created_at desc limit 100`));
  app.get('/api/consolidation/runs/:id', async (req) => getRun(sql, req.auth, uuidParam((req.params as { id: string }).id)));
  app.post('/api/consolidation/runs/:id/approve', async (req) =>
    transitionRun(deps, req.auth, uuidParam((req.params as { id: string }).id), 'approved', String(b(req).reason ?? 'Aprobación')));
  app.post('/api/consolidation/runs/:id/publish', async (req) =>
    transitionRun(deps, req.auth, uuidParam((req.params as { id: string }).id), 'published', String(b(req).reason ?? 'Publicación')));
  app.get('/api/consolidation/compare', async (req) => compareRuns(sql, req.auth, uuidParam(q(req).a, 'a'), uuidParam(q(req).b, 'b')));

  // ---------------------------------------------------------------- Capa semántica
  app.post('/api/semantic/query', async (req) => {
    requirePerm(req.auth, 'semantic.query');
    return executeSemanticQuery(req.body, qctx(req.auth), new PgFinancialQueryAdapter(sql, req.auth.userId));
  });
  app.get('/api/semantic/catalog', async () => {
    const c = await loadCatalog(sql);
    return { metrics: [...c.metrics.values()], dimensions: [...c.dimensions.values()] };
  });
  app.get('/api/variance', async (req) => {
    const x = q(req);
    if (!x.metric || !x.version || !x.compare_to || !x.period) throw badRequest('metric, version, compare_to y period son obligatorios');
    return varianceAnalysis(deps, req.auth, { metric: x.metric, version: x.version, compare_to: x.compare_to, period: x.period });
  });

  // ---------------------------------------------------------------- Trazabilidad
  app.get('/api/lineage/metric', async (req) => metricLineage(deps, req.auth, { run_id: uuidParam(q(req).run_id, 'run_id'),
    metric: String(q(req).metric ?? ''), company: q(req).company }));
  app.get('/api/lineage/entries', async (req) => listEntries(deps, req.auth, { run_id: uuidParam(q(req).run_id, 'run_id'),
    account: q(req).account, company: q(req).company, period: q(req).period, entry_type: q(req).entry_type, limit: Number(q(req).limit ?? 200) }));
  app.get('/api/lineage/line/:id', async (req) => lineChain(deps, req.auth, uuidParam((req.params as { id: string }).id)));

  // ---------------------------------------------------------------- Dashboards
  app.get('/api/dashboards', async (req) => listDashboards(sql, req.auth));
  app.post('/api/dashboards', async (req) => createDashboard(deps, req.auth, req.body as { name: string; template?: 'executive' | 'blank' }));
  app.get('/api/dashboards/:id', async (req) => getDashboard(sql, req.auth, uuidParam((req.params as { id: string }).id)));
  app.delete('/api/dashboards/:id', async (req) => archiveDashboard(deps, req.auth, uuidParam((req.params as { id: string }).id)));
  app.post('/api/dashboards/:id/actions', async (req) =>
    applyDashboardActions(deps, req.auth, uuidParam((req.params as { id: string }).id), b(req).actions, 'user'));
  app.post('/api/dashboards/:id/ai', async (req) =>
    dashboardInstruction(deps, req.auth, uuidParam((req.params as { id: string }).id), String(b(req).instruction ?? '')));
  app.post('/api/dashboards/:id/duplicate', async (req) => duplicateDashboard(deps, req.auth, uuidParam((req.params as { id: string }).id)));
  app.post('/api/dashboards/:id/share', async (req) => shareDashboard(deps, req.auth, uuidParam((req.params as { id: string }).id),
    String(b(req).email ?? ''), b(req).permission === 'edit' ? 'edit' : 'view'));
  app.get('/api/dashboards/:id/versions', async (req) => listVersions(sql, req.auth, uuidParam((req.params as { id: string }).id)));
  app.post('/api/dashboards/:id/restore', async (req) =>
    restoreVersion(deps, req.auth, uuidParam((req.params as { id: string }).id), Number(b(req).version)));
  app.post('/api/dashboards/:id/pending/:cid', async (req) => {
    const p = req.params as { id: string; cid: string };
    return confirmPendingChange(deps, req.auth, uuidParam(p.id), uuidParam(p.cid, 'cid'), b(req).accept === true);
  });
  app.get('/api/dashboards/:id/widgets/:wid/data', async (req) => {
    const p = req.params as { id: string; wid: string };
    const ctx = await agentContext(deps, req.auth);
    return widgetData(deps, req.auth, uuidParam(p.id), uuidParam(p.wid, 'wid'), {
      period: q(req).period ?? ctx.period, version: q(req).version ?? 'approved' });
  });

  // ---------------------------------------------------------------- IA
  app.post('/api/ai/ask', async (req) => askAnalyst(deps, req.auth, req.body as { question: string; conversation_id?: string }));
  app.get('/api/ai/conversations', async (req) => withUser(sql, req.auth.userId, (tx) => tx`
    select id, title, created_at from ai.conversations where organization_id = ${req.auth.organizationId} and context = 'analyst'
    order by created_at desc limit 30`));
  app.get('/api/ai/conversations/:id', async (req) => {
    const id = uuidParam((req.params as { id: string }).id);
    return withUser(sql, req.auth.userId, (tx) => tx`select id, role, content, structured, provider, created_at from ai.messages
      where conversation_id = ${id} order by created_at`);
  });
  app.get('/api/ai/context', async (req) => {
    const c = await agentContext(deps, req.auth);
    return { period: c.period, default_version: c.defaultVersion, versions: c.versions, companies: c.companies, provider: provider(deps).name };
  });

  // ---------------------------------------------------------------- Escenarios
  app.get('/api/scenarios', async (req) => listScenarios(sql, req.auth));
  app.post('/api/scenarios', async (req) => createScenario(deps, req.auth, req.body));

  // ---------------------------------------------------------------- Auditoría
  app.get('/api/audit/events', async (req) => {
    requirePerm(req.auth, 'audit.read');
    return withUser(sql, req.auth.userId, (tx) => tx`select e.id, e.action, e.entity_type, e.entity_id, e.details, e.created_at, p.full_name as user_name
      from audit.audit_events e left join core.users_profiles p on p.user_id = e.user_id
      where e.organization_id = ${req.auth.organizationId} order by e.id desc limit ${Math.min(Number(q(req).limit ?? 100), 500)}`);
  });
  app.get('/api/audit/queries/:id', async (req) => {
    const id = uuidParam((req.params as { id: string }).id);
    const [row] = await withUser(sql, req.auth.userId, (tx) => tx`select q.id, q.source, q.request, q.run_ids, q.row_count, q.duration_ms, q.status, q.error,
        q.created_at, p.full_name as user_name
      from semantic.query_executions q left join core.users_profiles p on p.user_id = q.user_id where q.id = ${id}`);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Consulta no encontrada o sin acceso');
    return row;
  });
  app.get('/api/audit/approvals', async (req) => {
    requirePerm(req.auth, 'audit.read');
    return withUser(sql, req.auth.userId, (tx) => tx`select a.id, a.entity_type, a.entity_id, a.action, a.from_status, a.to_status, a.reason,
        a.created_at, p.full_name as user_name
      from audit.approval_events a left join core.users_profiles p on p.user_id = a.user_id
      where a.organization_id = ${req.auth.organizationId} order by a.id desc limit 200`);
  });

  return app;
}
