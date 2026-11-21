import { applyActions, executiveTemplate, requiresApproval, toSemanticRequest, type DashboardState } from '@nexora/dashboard-engine';
import { DashboardAction, WidgetSpec, type SemanticFilters } from '@nexora/shared';
import { executeSemanticQuery, SemanticError, validateAgainstCatalog } from '@nexora/semantic-engine';
import { withUser, type Sql } from '@nexora/database';
import { audit, requirePerm, type AuthContext, type Deps } from '../context.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { loadCatalog, PgFinancialQueryAdapter } from './semantic-adapter.js';

interface DashRow {
  id: string; organization_id: string; owner_id: string; name: string; description: string; global_filters: Partial<SemanticFilters>;
  status: string; version: number; updated_at: string; created_at: string;
}
interface WidgetRow { id: string; title: string; type: string; spec: WidgetSpec; position: number; size: string; updated_at: string }

export async function listDashboards(sql: Sql, ctx: AuthContext) {
  return withUser(sql, ctx.userId, (tx) => tx<Array<DashRow & { widgets: number; owner_name: string | null; shared: boolean }>>`
    select d.*, (select count(*)::int from dashboards.widgets w where w.dashboard_id = d.id) as widgets,
           p.full_name as owner_name, d.owner_id <> ${ctx.userId}::uuid as shared
    from dashboards.dashboards d left join core.users_profiles p on p.user_id = d.owner_id
    where d.organization_id = ${ctx.organizationId} and d.status = 'active' order by d.updated_at desc`);
}

export async function getDashboard(sql: Sql, ctx: AuthContext, id: string) {
  return withUser(sql, ctx.userId, async (tx) => {
    const [d] = await tx<DashRow[]>`select * from dashboards.dashboards where id = ${id} and organization_id = ${ctx.organizationId}`;
    if (!d) throw notFound('Dashboard no encontrado o sin acceso');
    const widgets = await tx<WidgetRow[]>`select id, title, type, spec, position, size, updated_at from dashboards.widgets
      where dashboard_id = ${id} order by position`;
    const [share] = await tx<Array<{ permission: string }>>`select permission from dashboards.dashboard_shares
      where dashboard_id = ${id} and user_id = ${ctx.userId}`;
    const canEdit = d.owner_id === ctx.userId || share?.permission === 'edit';
    return { ...d, widgets, can_edit: canEdit };
  });
}

function stateOf(d: Awaited<ReturnType<typeof getDashboard>>): DashboardState {
  return { name: d.name, globalFilters: d.global_filters, widgets: d.widgets.map((w) => ({ id: w.id, spec: w.spec, position: w.position })) };
}

async function persist(sql: Sql, ctx: AuthContext, dashboardId: string, before: DashboardState, after: DashboardState, summary: string,
  source: 'user' | 'ai' | 'restore' | 'system') {
  return sql.begin(async (tx) => {
    const [d] = await tx<Array<{ version: number }>>`update dashboards.dashboards
      set name = ${after.name}, global_filters = ${JSON.stringify(after.globalFilters)}::text::jsonb, version = version + 1
      where id = ${dashboardId} returning version`;
    const keep = after.widgets.map((w) => w.id);
    await tx`delete from dashboards.widgets where dashboard_id = ${dashboardId} and not (id = any(${keep}::uuid[]))`;
    for (const w of after.widgets) {
      await tx`insert into dashboards.widgets (id, dashboard_id, organization_id, title, type, spec, position, size)
        values (${w.id}, ${dashboardId}, ${ctx.organizationId}, ${w.spec.title}, ${w.spec.type}, ${JSON.stringify(w.spec)}::text::jsonb, ${w.position}, ${w.spec.size})
        on conflict (id) do update set title = excluded.title, type = excluded.type, spec = excluded.spec, position = excluded.position,
          size = excluded.size`;
    }
    await tx`insert into dashboards.dashboard_versions (dashboard_id, version, snapshot, change_summary, source, created_by)
      values (${dashboardId}, ${d!.version}, ${JSON.stringify(after)}::text::jsonb, ${summary.slice(0, 500)}, ${source}, ${ctx.userId})`;
    await audit(tx, ctx, `dashboard.${source}_change`, 'dashboard', dashboardId, { summary, widgets_before: before.widgets.length, widgets_after: after.widgets.length });
    return d!.version;
  });
}

export async function specValidator(sql: Sql) {
  const catalog = await loadCatalog(sql);
  return (spec: WidgetSpec): string | null => {
    try {
      validateAgainstCatalog({ metrics: spec.metric_ids, dimensions: spec.dimensions,
        filters: { period: '2000', version: 'approved', compare_to: spec.filters.compare_to ?? (spec.metric_ids.includes('fx_effect') ? 'x' : undefined) },
        limit: 200 }, catalog);
      return null;
    } catch (e) {
      return e instanceof SemanticError ? e.message : 'Especificación inválida';
    }
  };
}

export async function createDashboard(deps: Deps, ctx: AuthContext, input: { name: string; description?: string; template?: 'executive' | 'blank';
  compare_to?: string }) {
  requirePerm(ctx, 'dashboard.create');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw badRequest('Nombre inválido');
  const [d] = await deps.sql<Array<{ id: string }>>`insert into dashboards.dashboards (organization_id, owner_id, name, description, version)
    values (${ctx.organizationId}, ${ctx.userId}, ${name}, ${input.description ?? ''}, 0) returning id`;
  const widgets = input.template === 'executive' ? executiveTemplate(input.compare_to) : [];
  const empty: DashboardState = { name, globalFilters: {}, widgets: [] };
  const validator = await specValidator(deps.sql);
  const { state } = applyActions(empty, widgets.map((w) => ({ action: 'add_widget', widget: w })), validator);
  await persist(deps.sql, ctx, d!.id, empty, state, input.template === 'executive' ? 'Creado desde plantilla ejecutiva' : 'Creado', 'system');
  return getDashboard(deps.sql, ctx, d!.id);
}

/** Aplica acciones declarativas. Si provienen de la IA y son destructivas o masivas, quedan pendientes de confirmación. */
export async function applyDashboardActions(deps: Deps, ctx: AuthContext, id: string, rawActions: unknown, source: 'user' | 'ai', explanation = '') {
  requirePerm(ctx, 'dashboard.create');
  if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.length > 12) throw badRequest('Se requieren entre 1 y 12 acciones');
  const parsed = rawActions.map((a) => DashboardAction.safeParse(a));
  const bad = parsed.find((p) => !p.success);
  if (bad && !bad.success) throw badRequest('Acción de dashboard inválida', bad.error.issues);
  const actions = parsed.map((p) => p.data!);
  const d = await getDashboard(deps.sql, ctx, id);
  if (!d.can_edit) throw forbidden('Sin permiso de edición sobre el dashboard');
  const before = stateOf(d);
  let result;
  try {
    result = applyActions(before, actions, await specValidator(deps.sql));
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const approval = requiresApproval(actions, result, source);
  if (approval) {
    const [p] = await deps.sql<Array<{ id: string }>>`insert into dashboards.pending_changes (dashboard_id, requested_by, actions, reason)
      values (${id}, ${ctx.userId}, ${JSON.stringify(actions)}::text::jsonb, ${approval}) returning id`;
    return { applied: false, pending_change_id: p!.id, reason: approval, summary: result.summary };
  }
  const version = await persist(deps.sql, ctx, id, before, result.state, [explanation, ...result.summary].filter(Boolean).join(' · '), source);
  return { applied: true, version, summary: result.summary, dashboard: await getDashboard(deps.sql, ctx, id) };
}

export async function confirmPendingChange(deps: Deps, ctx: AuthContext, dashboardId: string, changeId: string, accept: boolean) {
  const [p] = await deps.sql<Array<{ actions: unknown[]; status: string; requested_by: string }>>`
    select actions, status, requested_by from dashboards.pending_changes where id = ${changeId} and dashboard_id = ${dashboardId}`;
  if (!p || p.status !== 'pending') throw notFound('Cambio pendiente no encontrado');
  if (p.requested_by !== ctx.userId) throw forbidden('Solo quien solicitó el cambio puede confirmarlo');
  await deps.sql`update dashboards.pending_changes set status = ${accept ? 'applied' : 'rejected'} where id = ${changeId}`;
  if (!accept) return { applied: false };
  return applyDashboardActions(deps, ctx, dashboardId, p.actions, 'user', 'Cambio de IA confirmado por el usuario');
}

export async function restoreVersion(deps: Deps, ctx: AuthContext, id: string, version: number) {
  const d = await getDashboard(deps.sql, ctx, id);
  if (!d.can_edit) throw forbidden('Sin permiso de edición');
  const [v] = await deps.sql<Array<{ snapshot: DashboardState }>>`select snapshot from dashboards.dashboard_versions
    where dashboard_id = ${id} and version = ${version}`;
  if (!v) throw notFound('Versión no encontrada');
  const snap = v.snapshot;
  const validated: DashboardState = { name: snap.name, globalFilters: snap.globalFilters ?? {},
    widgets: snap.widgets.map((w, i) => ({ id: w.id, spec: WidgetSpec.parse(w.spec), position: i })) };
  const nv = await persist(deps.sql, ctx, id, stateOf(d), validated, `Restaurada la versión ${version}`, 'restore');
  return { version: nv, dashboard: await getDashboard(deps.sql, ctx, id) };
}

export async function listVersions(sql: Sql, ctx: AuthContext, id: string) {
  await getDashboard(sql, ctx, id);
  return withUser(sql, ctx.userId, (tx) => tx`select v.version, v.change_summary, v.source, v.created_at, p.full_name as created_by,
      jsonb_array_length(v.snapshot->'widgets') as widgets
    from dashboards.dashboard_versions v left join core.users_profiles p on p.user_id = v.created_by
    where v.dashboard_id = ${id} order by v.version desc limit 50`);
}

export async function duplicateDashboard(deps: Deps, ctx: AuthContext, id: string) {
  const d = await getDashboard(deps.sql, ctx, id);
  const copy = await createDashboard(deps, ctx, { name: `${d.name} (copia)`.slice(0, 120), description: d.description, template: 'blank' });
  return applyDashboardActions(deps, ctx, copy.id, [
    ...d.widgets.map((w) => ({ action: 'add_widget', widget: w.spec })),
    ...(Object.keys(d.global_filters).length ? [{ action: 'set_global_filters', filters: d.global_filters }] : []),
  ].slice(0, 12), 'user', `Duplicado de ${d.name}`);
}

export async function archiveDashboard(deps: Deps, ctx: AuthContext, id: string) {
  const d = await getDashboard(deps.sql, ctx, id);
  if (d.owner_id !== ctx.userId) throw forbidden('Solo el propietario puede eliminar el dashboard');
  await deps.sql`update dashboards.dashboards set status = 'archived' where id = ${id}`;
  await audit(deps.sql, ctx, 'dashboard.archive', 'dashboard', id);
  return { archived: true };
}

export async function shareDashboard(deps: Deps, ctx: AuthContext, id: string, email: string, permission: 'view' | 'edit') {
  requirePerm(ctx, 'dashboard.share');
  const d = await getDashboard(deps.sql, ctx, id);
  if (d.owner_id !== ctx.userId) throw forbidden('Solo el propietario puede compartir');
  const [u] = await deps.sql<Array<{ user_id: string }>>`select m.user_id from core.organization_members m
    join core.users_profiles p on p.user_id = m.user_id
    where m.organization_id = ${ctx.organizationId} and lower(p.email) = lower(${email})`;
  if (!u) throw notFound('El usuario no pertenece a la organización');
  await deps.sql`insert into dashboards.dashboard_shares (dashboard_id, user_id, permission) values (${id}, ${u.user_id}, ${permission})
    on conflict (dashboard_id, user_id) do update set permission = excluded.permission`;
  await audit(deps.sql, ctx, 'dashboard.share', 'dashboard', id, { user: u.user_id, permission });
  return { shared: true };
}

/** Datos de un widget: siempre consultados en vivo a la capa semántica (los valores no se guardan en el widget). */
export async function widgetData(deps: Deps, ctx: AuthContext, dashboardId: string, widgetId: string, defaults: { period: string; version: string }) {
  requirePerm(ctx, 'semantic.query');
  const d = await getDashboard(deps.sql, ctx, dashboardId);
  const w = d.widgets.find((x) => x.id === widgetId);
  if (!w) throw notFound('Widget no encontrado');
  const req = toSemanticRequest(w.spec, d.global_filters, defaults);
  return executeSemanticQuery(req, {
    organizationId: ctx.organizationId, userId: ctx.userId, hasAllCompanies: ctx.allCompanies, accessibleCompanyIds: ctx.companyIds, source: 'dashboard',
  }, new PgFinancialQueryAdapter(deps.sql, ctx.userId));
}
