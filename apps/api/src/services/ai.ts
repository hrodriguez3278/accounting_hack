import {
  AiProviderError, ANALYST_TOOLS, createProvider, planDashboard, runAnalyst, sanitizeUserText, looksLikeInjection, type AgentContext, type ChatMessage,
  type LlmProvider, type ToolExecutor,
} from '@nexora/ai-engine';
import { executeSemanticQuery, SemanticError } from '@nexora/semantic-engine';
import { withUser } from '@nexora/database';
import { requirePerm, type AuthContext, type Deps } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import { applyDashboardActions, getDashboard } from './dashboards.js';
import { createScenario, listScenarios, metricLineage, varianceAnalysis } from './analytics.js';
import { loadCatalog, PgFinancialQueryAdapter } from './semantic-adapter.js';

let providerSingleton: LlmProvider | null = null;
export function provider(deps: Deps): LlmProvider {
  providerSingleton ??= createProvider(deps.env);
  return providerSingleton;
}

export async function agentContext(deps: Deps, ctx: AuthContext, dashboardId?: string): Promise<AgentContext> {
  const catalog = await loadCatalog(deps.sql);
  return withUser(deps.sql, ctx.userId, async (tx) => {
    const versions = await tx<Array<{ code: string; name: string; kind: string; fiscal_year: number; published: boolean; published_at: string | null }>>`
      select v.code, v.name, v.kind, v.fiscal_year,
             exists (select 1 from gold.consolidation_runs r where r.budget_version_id = v.id and r.status = 'published') as published,
             (select max(published_at) from gold.consolidation_runs r where r.budget_version_id = v.id and r.status = 'published') as published_at
      from core.budget_versions v where v.organization_id = ${ctx.organizationId} order by v.code`;
    const companies = await tx<Array<{ code: string; name: string; country_code: string }>>`
      select code, name, country_code from core.companies where organization_id = ${ctx.organizationId} order by code`;
    const latest = versions.filter((v) => v.kind === 'budget' && v.published)
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    let dashboard: AgentContext['dashboard'];
    if (dashboardId) {
      const d = await getDashboard(deps.sql, ctx, dashboardId);
      dashboard = { id: d.id, name: d.name, widgets: d.widgets.map((w) => ({ id: w.id, title: w.title, spec: w.spec })) };
    }
    return {
      period: String(latest?.fiscal_year ?? versions[0]?.fiscal_year ?? new Date().getFullYear()),
      defaultVersion: latest?.code ?? 'approved',
      versions: versions.map((v) => ({ code: v.code, name: v.name, kind: v.kind, published: v.published })),
      companies: companies.map((c) => ({ code: c.code, name: c.name, country: c.country_code })),
      catalog, dashboard,
    };
  });
}

function toolExecutor(deps: Deps, ctx: AuthContext, dashboardId?: string): ToolExecutor {
  const qctx = { organizationId: ctx.organizationId, userId: ctx.userId, hasAllCompanies: ctx.allCompanies, accessibleCompanyIds: ctx.companyIds,
    source: 'ai' as const };
  const adapter = new PgFinancialQueryAdapter(deps.sql, ctx.userId);
  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      return { status: 'ok' as const, result: await fn() };
    } catch (e) {
      if (e instanceof SemanticError) return { status: (e.status === 403 ? 'denied' : 'invalid') as 'denied' | 'invalid', result: { error: e.message } };
      if (e instanceof HttpError) return { status: (e.status === 403 ? 'denied' : 'invalid') as 'denied' | 'invalid', result: { error: e.message } };
      throw e;
    }
  };
  return async (name, args) => {
    const a = args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (name) {
      case 'list_available_metrics':
        return wrap(async () => [...(await loadCatalog(deps.sql)).metrics.values()].filter((m) => m.version !== null)
          .map((m) => ({ code: m.code, name: m.name, unit: m.unit, formula: m.formula, dimensions: m.dimensions })));
      case 'list_dimensions':
        return wrap(async () => [...(await loadCatalog(deps.sql)).dimensions.values()]);
      case 'get_metric_definition':
        return wrap(async () => {
          const m = (await loadCatalog(deps.sql)).metrics.get(a.metric);
          if (!m) throw new SemanticError('UNKNOWN_METRIC', `Métrica inexistente: ${a.metric}`);
          return m;
        });
      case 'query_financial_metrics':
        return wrap(() => { requirePerm(ctx, 'semantic.query'); return executeSemanticQuery({ ...a, limit: a.limit ?? 50 }, qctx, adapter); });
      case 'compare_budget_versions':
        return wrap(() => varianceAnalysis(deps, ctx, a as { metric: string; version: string; compare_to: string; period: string }));
      case 'get_budget_variances':
        return wrap(() => executeSemanticQuery({ metrics: [a.metric], dimensions: ['company'],
          filters: { period: a.period, version: a.version, compare_to: a.compare_to }, limit: 50 }, qctx, adapter));
      case 'get_consolidation_details':
        return wrap(async () => {
          const v = await adapter.resolveVersion(ctx.organizationId, a.version, Number(a.period));
          if (!v) throw new SemanticError('UNKNOWN_VERSION', `Versión inexistente: ${a.version}`, 404);
          const run = await adapter.resolveRun(ctx.organizationId, v.id);
          if (!run) throw new SemanticError('NO_CONSOLIDATION', 'Sin consolidación disponible', 404);
          return withUser(deps.sql, ctx.userId, async (tx) => {
            const [r] = await tx`select id, status, inputs_hash, summary, finished_at, published_at from gold.consolidation_runs where id = ${run.id}`;
            const ic = await tx<Array<{ status: string; n: number }>>`select status, count(*)::int as n from silver.current_intercompany_matches
              where budget_version_id = ${v.id} group by status`;
            const icn = (s: string) => ic.find((x) => x.status === s)?.n ?? 0;
            return { version: v.code, run: r, ic: { matched: icn('matched'), accepted_difference: icn('accepted_difference'),
              mismatch: icn('mismatch'), unmatched: icn('unmatched') } };
          });
        });
      case 'get_validation_issues':
        return wrap(async () => {
          const v = await adapter.resolveVersion(ctx.organizationId, a.version, Number(a.period));
          if (!v) throw new SemanticError('UNKNOWN_VERSION', `Versión inexistente: ${a.version}`, 404);
          const issues = await withUser(deps.sql, ctx.userId, (tx) => tx`
            select i.id, i.rule_code, r.name as rule_name, i.severity, i.status, i.description, c.code as company_code
            from silver.validation_issues i join silver.validation_rules r on r.code = i.rule_code
            left join core.companies c on c.id = i.company_id
            where i.budget_version_id = ${v.id} ${a.status ? tx`and i.status = ${a.status}` : tx``}
            order by (i.status = 'open') desc, i.severity, i.created_at limit 100`);
          return { version: v.code, issues };
        });
      case 'get_lineage':
        return wrap(async () => {
          const v = await adapter.resolveVersion(ctx.organizationId, a.version, Number(a.period));
          if (!v) throw new SemanticError('UNKNOWN_VERSION', `Versión inexistente: ${a.version}`, 404);
          const run = await adapter.resolveRun(ctx.organizationId, v.id);
          if (!run) throw new SemanticError('NO_CONSOLIDATION', 'Sin consolidación disponible', 404);
          return metricLineage(deps, ctx, { run_id: run.id, metric: a.metric, company: a.company });
        });
      case 'create_dashboard_widget':
      case 'update_dashboard_widget':
      case 'remove_dashboard_widget':
        return wrap(async () => {
          if (!dashboardId) throw new HttpError(400, 'NO_DASHBOARD', 'No hay un dashboard activo');
          const action = name === 'create_dashboard_widget' ? { action: 'add_widget', widget: a.widget }
            : name === 'update_dashboard_widget' ? { action: 'update_widget', widget_id: a.widget_id, changes: a.changes }
              : { action: 'remove_widget', widget_id: a.widget_id };
          const r = await applyDashboardActions(deps, ctx, dashboardId, [action], 'ai');
          return { applied: r.applied, summary: r.summary };
        });
      case 'create_scenario':
        return wrap(() => createScenario(deps, ctx, a));
      case 'run_scenario':
        return wrap(async () => {
          const s = (await listScenarios(deps.sql, ctx)).find((x) => x.id === a.scenario_id);
          if (!s) throw new HttpError(404, 'NOT_FOUND', 'Escenario no encontrado');
          return s;
        });
      default:
        return { status: 'denied', result: { error: `Herramienta no autorizada: ${name}` } };
    }
  };
}

export async function askAnalyst(deps: Deps, ctx: AuthContext, input: { question: string; conversation_id?: string }) {
  requirePerm(ctx, 'ai.use');
  const question = sanitizeUserText(String(input.question ?? ''));
  if (question.length < 3) throw new HttpError(400, 'BAD_REQUEST', 'Pregunta vacía');
  const { sql } = deps;
  let conversationId = input.conversation_id;
  if (conversationId) {
    const [c] = await sql`select id from ai.conversations where id = ${conversationId} and user_id = ${ctx.userId}`;
    if (!c) throw notFound('Conversación no encontrada');
  } else {
    const [c] = await sql<Array<{ id: string }>>`insert into ai.conversations (organization_id, user_id, title, context)
      values (${ctx.organizationId}, ${ctx.userId}, ${question.slice(0, 80)}, 'analyst') returning id`;
    conversationId = c!.id;
  }
  const prior = await sql<Array<{ role: 'user' | 'assistant'; content: string }>>`
    select role, content from ai.messages where conversation_id = ${conversationId} order by created_at desc limit 8`;
  const history: ChatMessage[] = prior.reverse().map((m) => m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
  const p = provider(deps);
  const context = await agentContext(deps, ctx);
  const res = await runAnalyst({ provider: p, question, history, context, allowedTools: ANALYST_TOOLS, execute: toolExecutor(deps, ctx) });

  const messageId = await sql.begin(async (tx) => {
    await tx`insert into ai.messages (conversation_id, organization_id, role, content) values (${conversationId}, ${ctx.organizationId}, 'user', ${question})`;
    const [m] = await tx<Array<{ id: string }>>`insert into ai.messages (conversation_id, organization_id, role, content, structured, provider)
      values (${conversationId}, ${ctx.organizationId}, 'assistant', ${res.answer},
              ${JSON.stringify({ evidence: res.evidence, grounding: res.grounding, injection_suspected: res.injectionSuspected,
                tools: res.toolExecutions.map((t) => ({ name: t.name, status: t.status })) })}::text::jsonb, ${res.provider})
      returning id`;
    for (const t of res.toolExecutions) {
      const qid = (t.result as Record<string, unknown> | null)?.query_id;
      await tx`insert into ai.tool_executions (conversation_id, message_id, organization_id, user_id, tool_name, arguments, result, status, duration_ms,
          query_execution_id)
        values (${conversationId}, ${m!.id}, ${ctx.organizationId}, ${ctx.userId}, ${t.name}, ${JSON.stringify(t.arguments ?? {})}::text::jsonb,
                ${JSON.stringify(t.result ?? null).slice(0, 200_000)}::text::jsonb, ${t.status}, ${t.durationMs}, ${typeof qid === 'string' ? qid : null})`;
    }
    return m!.id;
  });
  return { conversation_id: conversationId, message_id: messageId, ...res,
    tool_executions: res.toolExecutions.map((t) => ({ name: t.name, status: t.status, arguments: t.arguments, duration_ms: t.durationMs })) };
}

export async function dashboardInstruction(deps: Deps, ctx: AuthContext, dashboardId: string, instruction: string) {
  requirePerm(ctx, 'ai.use');
  const text = sanitizeUserText(String(instruction ?? ''), 600);
  if (text.length < 3) throw new HttpError(400, 'BAD_REQUEST', 'Instrucción vacía');
  const context = await agentContext(deps, ctx, dashboardId);
  let plan;
  try {
    plan = await planDashboard(provider(deps), text, context);
  } catch (e) {
    if (e instanceof AiProviderError) throw e;
    throw new HttpError(422, 'PLAN_INVALID', `No se pudo interpretar la instrucción de forma segura: ${(e as Error).message.slice(0, 200)}`);
  }
  const injection = looksLikeInjection(text);
  if (!plan.actions.length) return { applied: false, plan, injection_suspected: injection, summary: [plan.explanation] };
  const result = await applyDashboardActions(deps, ctx, dashboardId, plan.actions, 'ai', plan.explanation);
  await deps.sql`insert into ai.tool_executions (organization_id, user_id, tool_name, arguments, result, status)
    values (${ctx.organizationId}, ${ctx.userId}, 'apply_dashboard_plan', ${JSON.stringify({ instruction: text, plan })}::text::jsonb,
            ${JSON.stringify({ applied: result.applied, summary: result.summary })}::text::jsonb, 'ok')`;
  return { ...result, plan, injection_suspected: injection, provider: provider(deps).name };
}
