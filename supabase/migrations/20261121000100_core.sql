-- NEXORA AI · 0100 · Esquema core: organizaciones, empresas, catálogos, identidad y permisos
-- Los esquemas internos NO se exponen por la Data API de Supabase (config.toml: api.schemas = public).

create schema if not exists core;
create schema if not exists bronze;
create schema if not exists silver;
create schema if not exists gold;
create schema if not exists semantic;
create schema if not exists ai;
create schema if not exists dashboards;
create schema if not exists scenarios;
create schema if not exists audit;

-- Utilidad: updated_at automático
create or replace function core.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- catálogos globales
create table core.currencies (
  code        char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name        text not null,
  decimals    smallint not null default 2 check (decimals between 0 and 6)
);

create table core.countries (
  code        char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name        text not null,
  default_currency char(3) references core.currencies(code)
);

-- ---------------------------------------------------------------- organizaciones y empresas
create table core.organizations (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique check (slug ~ '^[a-z0-9-]{3,64}$'),
  name                  text not null,
  presentation_currency char(3) not null references core.currencies(code),
  is_demo               boolean not null default false,
  settings              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_org_touch before update on core.organizations for each row execute function core.touch_updated_at();

create table core.companies (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  code                text not null check (code ~ '^[A-Z0-9-]{2,20}$'),
  name                text not null,
  country_code        char(2) not null references core.countries(code),
  functional_currency char(3) not null references core.currencies(code),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, code),
  unique (organization_id, id)
);
create trigger trg_company_touch before update on core.companies for each row execute function core.touch_updated_at();

create table core.fiscal_periods (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  code            text not null check (code ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  calendar_year   smallint not null,
  month           smallint not null check (month between 1 and 12),
  fiscal_year     smallint not null,
  is_opening      boolean not null default false,  -- saldo inicial del ejercicio (balance de apertura)
  status          text not null default 'open' check (status in ('open', 'closed')),
  unique (organization_id, code)
);

create table core.budget_versions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  code                   text not null check (code ~ '^[A-Z0-9-]{3,40}$'),
  name                   text not null,
  kind                   text not null check (kind in ('budget', 'forecast', 'actual')),
  fiscal_year            smallint not null,
  rate_scenario          text not null,          -- conjunto de tasas aprobado que usa la versión
  includes_balance_sheet boolean not null default true,
  status                 text not null default 'open' check (status in ('open', 'locked', 'archived')),
  created_at             timestamptz not null default now(),
  unique (organization_id, code)
);

-- Parámetros financieros aprobados (WACC, tasa NOPAT, tolerancias). Nunca inventados: se registran con fuente y aprobación.
create table core.financial_parameters (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  fiscal_year     smallint not null,
  code            text not null check (code ~ '^[a-z_]{3,40}$'),
  value           numeric(20, 10) not null,
  description     text not null,
  status          text not null default 'approved' check (status in ('proposed', 'approved', 'retired')),
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz default now(),
  created_at      timestamptz not null default now(),
  unique (organization_id, fiscal_year, code)
);

-- ---------------------------------------------------------------- identidad y permisos
create table core.users_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  locale      text not null default 'es',
  created_at  timestamptz not null default now()
);

create table core.roles (
  code        text primary key,
  name        text not null,
  description text not null,
  rank        smallint not null
);

create table core.permissions (
  code        text primary key,
  description text not null
);

create table core.role_permissions (
  role_code       text not null references core.roles(code) on delete cascade,
  permission_code text not null references core.permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

create table core.organization_members (
  organization_id uuid not null references core.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role_code       text not null references core.roles(code),
  all_companies   boolean not null default false,  -- acceso a todas las empresas y a cifras de grupo
  status          text not null default 'active' check (status in ('active', 'suspended')),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index on core.organization_members (user_id);

create table core.company_access (
  organization_id uuid not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  company_id      uuid not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, company_id),
  foreign key (organization_id, company_id) references core.companies(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id) references core.organization_members(organization_id, user_id) on delete cascade
);

insert into core.roles (code, name, description, rank) values
  ('super_admin', 'Super Admin', 'Administración total de la plataforma', 100),
  ('org_admin', 'Organization Admin', 'Administra usuarios, empresas y configuración del grupo', 90),
  ('financial_admin', 'Financial Administrator', 'Gestiona catálogos, tasas, consolidaciones y aprobaciones', 80),
  ('director', 'Director', 'Consulta información consolidada, aprueba y usa IA', 70),
  ('financial_analyst', 'Financial Analyst', 'Carga datos, revisa calidad y analiza', 60),
  ('auditor', 'Auditor', 'Lectura completa con acceso a auditoría', 50),
  ('viewer', 'Viewer', 'Solo lectura de cifras autorizadas', 10);

insert into core.permissions (code, description) values
  ('org.admin', 'Administrar organización, miembros y accesos'),
  ('company.manage', 'Crear y editar empresas'),
  ('data.upload', 'Cargar archivos presupuestarios'),
  ('data.read', 'Consultar cargas y registros de origen'),
  ('mapping.manage', 'Gestionar mapeos de columnas y homologación de cuentas'),
  ('rates.manage', 'Registrar y aprobar tasas de cambio'),
  ('quality.review', 'Revisar incidencias de calidad'),
  ('quality.resolve', 'Resolver incidencias (excluir, corregir campos no monetarios)'),
  ('quality.approve', 'Aprobar advertencias, diferencias IC y correcciones de importes'),
  ('consolidation.run', 'Ejecutar consolidaciones'),
  ('consolidation.approve', 'Aprobar consolidaciones'),
  ('consolidation.publish', 'Publicar consolidaciones'),
  ('adjustment.propose', 'Proponer ajustes de consolidación'),
  ('adjustment.approve', 'Aprobar ajustes de consolidación'),
  ('financial.read', 'Consultar cifras financieras'),
  ('semantic.query', 'Consultar la capa semántica'),
  ('metric.approve', 'Aprobar definiciones oficiales de métricas'),
  ('dashboard.create', 'Crear y editar dashboards propios'),
  ('dashboard.share', 'Compartir dashboards'),
  ('ai.use', 'Usar el analista financiero y el estudio de dashboards con IA'),
  ('scenario.create', 'Crear y ejecutar escenarios'),
  ('audit.read', 'Consultar auditoría y trazabilidad completa');

-- super_admin y org_admin: todos los permisos
insert into core.role_permissions (role_code, permission_code)
select r.code, p.code from core.roles r cross join core.permissions p where r.code in ('super_admin', 'org_admin');

insert into core.role_permissions (role_code, permission_code)
select 'financial_admin', code from core.permissions where code not in ('org.admin', 'company.manage');

insert into core.role_permissions (role_code, permission_code) values
  ('director', 'financial.read'), ('director', 'semantic.query'), ('director', 'dashboard.create'), ('director', 'dashboard.share'),
  ('director', 'ai.use'), ('director', 'scenario.create'), ('director', 'consolidation.approve'), ('director', 'data.read'),
  ('director', 'quality.review'), ('director', 'audit.read'),
  ('financial_analyst', 'data.upload'), ('financial_analyst', 'data.read'), ('financial_analyst', 'quality.review'),
  ('financial_analyst', 'quality.resolve'), ('financial_analyst', 'consolidation.run'), ('financial_analyst', 'adjustment.propose'),
  ('financial_analyst', 'financial.read'), ('financial_analyst', 'semantic.query'), ('financial_analyst', 'dashboard.create'),
  ('financial_analyst', 'ai.use'), ('financial_analyst', 'scenario.create'),
  ('auditor', 'financial.read'), ('auditor', 'semantic.query'), ('auditor', 'data.read'), ('auditor', 'audit.read'), ('auditor', 'quality.review'),
  ('viewer', 'financial.read'), ('viewer', 'semantic.query'), ('viewer', 'dashboard.create');

-- ---------------------------------------------------------------- funciones de autorización (usadas por RLS y por la API)
create or replace function core.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
  );
$$;

create or replace function core.has_all_companies(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active' and m.all_companies
  );
$$;

create or replace function core.can_access_company(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from core.companies c
    join core.organization_members m on m.organization_id = c.organization_id and m.user_id = auth.uid() and m.status = 'active'
    where c.id = p_company
      and (m.all_companies or exists (
        select 1 from core.company_access a where a.user_id = m.user_id and a.company_id = c.id))
  );
$$;

create or replace function core.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from core.organization_members m
    join core.role_permissions rp on rp.role_code = m.role_code
    where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
      and rp.permission_code = p_permission
  );
$$;

revoke all on function core.is_member(uuid), core.has_all_companies(uuid), core.can_access_company(uuid), core.has_permission(uuid, text) from public, anon;
