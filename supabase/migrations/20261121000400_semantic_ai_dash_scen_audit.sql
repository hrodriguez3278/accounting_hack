-- NEXORA AI · 0400 · Capa semántica, IA, dashboards, escenarios y auditoría

-- ---------------------------------------------------------------- SEMANTIC
create table semantic.metrics (
  code        text primary key check (code ~ '^[a-z_]{2,40}$'),
  name        text not null,
  description text not null,
  unit        text not null check (unit in ('currency', 'ratio')),
  category    text not null,
  kind        text not null check (kind in ('base', 'derived')),
  higher_is_better boolean not null default true
);

create table semantic.metric_versions (
  metric_code    text not null references semantic.metrics(code) on delete cascade,
  version        integer not null check (version > 0),
  formula        text not null,          -- expresión legible (documental); el cálculo usa la estrategia registrada
  strategy       text not null,          -- identificador de la estrategia en @nexora/financial-engine
  components     jsonb not null,         -- componentes requeridos
  aggregation    text not null,          -- regla de agregación (p.ej. 'recalculate_from_components')
  status         text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  approved_by    uuid references auth.users(id),
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  primary key (metric_code, version)
);
create unique index metric_one_approved on semantic.metric_versions (metric_code) where status = 'approved';

create table semantic.dimensions (
  code        text primary key,
  name        text not null,
  description text not null
);

create table semantic.metric_dimensions (
  metric_code    text not null references semantic.metrics(code) on delete cascade,
  dimension_code text not null references semantic.dimensions(code) on delete cascade,
  primary key (metric_code, dimension_code)
);

create table semantic.semantic_relationships (
  from_metric text not null references semantic.metrics(code) on delete cascade,
  to_metric   text not null references semantic.metrics(code) on delete cascade,
  relation    text not null check (relation in ('component_of', 'related')),
  primary key (from_metric, to_metric, relation)
);

create table semantic.synonyms (
  term        text primary key check (term = lower(term)),
  target_type text not null check (target_type in ('metric', 'dimension', 'chart')),
  target_code text not null,
  locale      text not null default 'es'
);

create table semantic.query_executions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  user_id         uuid references auth.users(id),
  source          text not null check (source in ('ui', 'ai', 'dashboard', 'api', 'test')),
  request         jsonb not null,
  run_ids         uuid[] not null default '{}',
  row_count       integer,
  duration_ms     integer,
  status          text not null check (status in ('ok', 'rejected', 'error')),
  error           text,
  created_at      timestamptz not null default now()
);
create index on semantic.query_executions (organization_id, created_at desc);

-- ---------------------------------------------------------------- AI
create table ai.conversations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text not null default 'Nueva conversación',
  context         text not null default 'analyst' check (context in ('analyst', 'dashboard')),
  created_at      timestamptz not null default now()
);

create table ai.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai.conversations(id) on delete cascade,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  structured      jsonb not null default '{}'::jsonb,   -- evidencias, advertencias de verificación, acciones aplicadas
  provider        text,
  created_at      timestamptz not null default now()
);
create index on ai.messages (conversation_id, created_at);

create table ai.tool_executions (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid references ai.conversations(id) on delete cascade,
  message_id         uuid references ai.messages(id) on delete set null,
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  user_id            uuid not null references auth.users(id),
  tool_name          text not null,
  arguments          jsonb not null,
  result             jsonb,
  status             text not null check (status in ('ok', 'denied', 'invalid', 'error')),
  duration_ms        integer,
  query_execution_id uuid references semantic.query_executions(id),
  created_at         timestamptz not null default now()
);

create table ai.analysis_results (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  message_id      uuid references ai.messages(id) on delete cascade,
  kind            text not null,
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- DASHBOARDS
create table dashboards.dashboards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  name            text not null check (length(name) between 1 and 120),
  description     text not null default '',
  global_filters  jsonb not null default '{}'::jsonb,
  status          text not null default 'active' check (status in ('active', 'archived')),
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger trg_dash_touch before update on dashboards.dashboards for each row execute function core.touch_updated_at();

create table dashboards.widgets (
  id              uuid primary key default gen_random_uuid(),
  dashboard_id    uuid not null references dashboards.dashboards(id) on delete cascade,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  title           text not null,
  type            text not null,
  spec            jsonb not null,    -- WidgetSpec validado por Zod (sin código ejecutable)
  position        integer not null,
  size            text not null default 'md' check (size in ('sm', 'md', 'lg', 'xl')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on dashboards.widgets (dashboard_id, position);
create trigger trg_widget_touch before update on dashboards.widgets for each row execute function core.touch_updated_at();

create table dashboards.dashboard_versions (
  id           uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references dashboards.dashboards(id) on delete cascade,
  version      integer not null,
  snapshot     jsonb not null,       -- dashboard + widgets completos (sin valores financieros)
  change_summary text not null,
  source       text not null check (source in ('user', 'ai', 'restore', 'system')),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (dashboard_id, version)
);

create table dashboards.dashboard_shares (
  dashboard_id uuid not null references dashboards.dashboards(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  permission   text not null default 'view' check (permission in ('view', 'edit')),
  created_at   timestamptz not null default now(),
  primary key (dashboard_id, user_id)
);

create table dashboards.pending_changes (
  id           uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references dashboards.dashboards(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  actions      jsonb not null,
  reason       text not null,
  status       text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- SCENARIOS
create table scenarios.scenarios (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  base_run_id     uuid not null references gold.consolidation_runs(id),
  name            text not null,
  description     text not null default '',
  status          text not null default 'draft' check (status in ('draft', 'complete', 'incomplete')),
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  computed_at     timestamptz
);

create table scenarios.scenario_assumptions (
  scenario_id uuid not null references scenarios.scenarios(id) on delete cascade,
  code        text not null,
  value       numeric(20, 10) not null,
  description text not null,
  primary key (scenario_id, code)
);

create table scenarios.scenario_results (
  scenario_id    uuid not null references scenarios.scenarios(id) on delete cascade,
  metric_code    text not null,
  base_value     numeric(30, 12),
  scenario_value numeric(30, 12),
  delta          numeric(30, 12),
  unit           text not null,
  status         text not null check (status in ('calculated', 'not_calculable')),
  missing        jsonb not null default '[]'::jsonb,
  primary key (scenario_id, metric_code)
);

-- ---------------------------------------------------------------- AUDIT
create table audit.audit_events (
  id              bigint generated always as identity primary key,
  organization_id uuid references core.organizations(id) on delete cascade,
  user_id         uuid references auth.users(id),
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index on audit.audit_events (organization_id, created_at desc);

create table audit.approval_events (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  entity_type     text not null,
  entity_id       text not null,
  action          text not null,
  from_status     text,
  to_status       text,
  user_id         uuid references auth.users(id),
  reason          text,
  created_at      timestamptz not null default now()
);
create index on audit.approval_events (entity_type, entity_id);

-- Enlaces de procedencia derivados que no se expresan por FK directa (p.ej. consulta → corrida, widget → consulta)
create table audit.data_lineage (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  from_type       text not null,
  from_id         text not null,
  to_type         text not null,
  to_id           text not null,
  relation        text not null,
  created_at      timestamptz not null default now()
);
create index on audit.data_lineage (from_type, from_id);

-- Los eventos de auditoría son de solo inserción
create or replace function audit.prevent_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Los registros de auditoría son de solo inserción' using errcode = 'P0001';
end $$;
create trigger trg_audit_append_only before update or delete on audit.audit_events
  for each row execute function audit.prevent_change();
create trigger trg_approval_append_only before update or delete on audit.approval_events
  for each row execute function audit.prevent_change();
