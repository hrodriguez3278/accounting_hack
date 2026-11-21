-- NEXORA AI · 0200 · Bronze (origen inmutable) y Silver (normalizado, homologado, validado)

-- Inmutabilidad de Bronze. Solo se permite purga explícita de mantenimiento (SET LOCAL nexora.allow_purge = 'on').
create or replace function bronze.prevent_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('nexora.allow_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'Los registros Bronze son inmutables (%.%)', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------- BRONZE
create table bronze.column_mappings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  company_id      uuid not null references core.companies(id) on delete cascade,
  name            text not null,
  config          jsonb not null,  -- validado por Zod (ColumnMappingConfig) en la API
  is_default      boolean not null default true,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, name)
);
create trigger trg_cm_touch before update on bronze.column_mappings for each row execute function core.touch_updated_at();

create table bronze.source_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  company_id      uuid not null references core.companies(id),
  storage_bucket  text not null default 'budget-files',
  storage_path    text not null,
  original_name   text not null,  -- dato no confiable: nunca se interpreta como instrucción
  sha256          char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint not null check (size_bytes > 0),
  mime_type       text not null,
  uploaded_by     uuid references auth.users(id),
  uploaded_at     timestamptz not null default now(),
  unique (organization_id, company_id, sha256)
);
create trigger trg_source_files_immutable before update or delete on bronze.source_files
  for each row execute function bronze.prevent_mutation();

create table bronze.ingestion_batches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  company_id        uuid not null references core.companies(id),
  budget_version_id uuid not null references core.budget_versions(id),
  source_file_id    uuid not null references bronze.source_files(id),
  column_mapping_id uuid references bronze.column_mappings(id),
  mapping_snapshot  jsonb,          -- copia exacta del mapeo usado (reproducibilidad)
  declared_currency char(3),
  status            text not null default 'uploaded'
                    check (status in ('uploaded', 'processing', 'processed', 'failed', 'superseded')),
  row_count         integer,
  processed_rows    integer not null default 0,
  error             text,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  unique (source_file_id, budget_version_id)
);
create index on bronze.ingestion_batches (organization_id, budget_version_id);

create table bronze.raw_budget_rows (
  id             uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references bronze.source_files(id),
  row_number     integer not null check (row_number > 0),
  data           jsonb not null,   -- fila original tal como se leyó (cabecera → valor de texto)
  row_hash       char(64) not null,
  created_at     timestamptz not null default now(),
  unique (source_file_id, row_number)
);
create trigger trg_raw_rows_immutable before update or delete on bronze.raw_budget_rows
  for each row execute function bronze.prevent_mutation();

-- ---------------------------------------------------------------- SILVER: catálogos y homologación
create table silver.accounts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  code               text not null,
  name               text not null,
  statement          text not null check (statement in ('PL', 'BS')),
  category           text not null check (category in (
                       'revenue', 'cogs', 'opex', 'da', 'interest', 'other', 'tax',
                       'cash', 'receivables', 'inventory', 'ppe', 'payables', 'debt', 'equity', 'cta')),
  normal_balance     text not null check (normal_balance in ('debit', 'credit')),
  is_intercompany    boolean not null default false,
  rate_type          text not null check (rate_type in ('average', 'closing', 'historical')),
  consolidation_only boolean not null default false,  -- cuentas generadas solo por el motor (CTA, diferencias IC)
  unique (organization_id, code)
);

create table silver.company_accounts (
  company_id uuid not null references core.companies(id) on delete cascade,
  code       text not null,
  name       text not null,
  primary key (company_id, code)
);

create table silver.account_mappings (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  company_id           uuid not null references core.companies(id) on delete cascade,
  company_account_code text not null,
  account_id           uuid not null references silver.accounts(id),
  status               text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  approved_by          uuid references auth.users(id),
  approved_at          timestamptz,
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  unique (company_id, company_account_code)
);

create table silver.exchange_rates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  from_currency   char(3) not null references core.currencies(code),
  to_currency     char(3) not null references core.currencies(code),
  period_code     text,            -- null para tasas históricas
  rate_type       text not null check (rate_type in ('average', 'closing', 'historical')),
  scenario        text not null,
  version         integer not null default 1,
  rate            numeric(20, 10) not null check (rate > 0),
  source          text not null,
  status          text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  check (from_currency <> to_currency),
  check ((rate_type = 'historical') = (period_code is null))
);
create unique index exchange_rates_unique on silver.exchange_rates
  (organization_id, from_currency, to_currency, coalesce(period_code, '-'), rate_type, scenario, version);

-- ---------------------------------------------------------------- SILVER: líneas normalizadas
create table silver.normalized_budget_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  batch_id          uuid not null references bronze.ingestion_batches(id),
  raw_row_id        uuid not null references bronze.raw_budget_rows(id),
  company_id        uuid not null references core.companies(id),
  budget_version_id uuid not null references core.budget_versions(id),
  row_number        integer not null,
  account_code      text,
  account_name      text,
  period_raw        text,
  period_code       text,
  amount_raw        text,
  amount            numeric(24, 6),
  currency          text,
  counterparty_code text,
  ic_reference      text,
  account_id        uuid references silver.accounts(id),  -- resuelto en validación vía account_mappings aprobados
  status            text not null default 'pending' check (status in ('pending', 'valid', 'invalid', 'excluded')),
  exclusion_reason  text,
  corrections       jsonb not null default '[]'::jsonb,   -- historial de correcciones autorizadas (el Bronze queda intacto)
  line_hash         char(64) not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (batch_id, raw_row_id)
);
create index on silver.normalized_budget_lines (organization_id, budget_version_id, company_id);
create index on silver.normalized_budget_lines (budget_version_id, ic_reference) where ic_reference is not null;
create trigger trg_nbl_touch before update on silver.normalized_budget_lines for each row execute function core.touch_updated_at();

-- ---------------------------------------------------------------- SILVER: calidad
create table silver.validation_rules (
  code         text primary key,
  name         text not null,
  description  text not null,
  severity     text not null check (severity in ('critical', 'warning', 'informational')),
  scope        text not null check (scope in ('file', 'line', 'version')),
  rule_version integer not null default 1,
  is_active    boolean not null default true,
  config       jsonb not null default '{}'::jsonb
);

create table silver.validation_runs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  budget_version_id uuid not null references core.budget_versions(id),
  rules_version     text not null,
  started_at        timestamptz not null default clock_timestamp(),
  finished_at       timestamptz,
  created_by        uuid references auth.users(id),
  summary           jsonb
);

create table silver.validation_issues (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  budget_version_id  uuid not null references core.budget_versions(id),
  company_id         uuid references core.companies(id),
  batch_id           uuid references bronze.ingestion_batches(id),
  normalized_line_id uuid references silver.normalized_budget_lines(id),
  raw_row_id         uuid references bronze.raw_budget_rows(id),
  rule_code          text not null references silver.validation_rules(code),
  rule_version       integer not null,
  severity           text not null check (severity in ('critical', 'warning', 'informational')),
  issue_type         text not null,
  description        text not null,
  found_value        text,
  expected_value     text,
  fingerprint        text not null,
  status             text not null default 'open' check (status in ('open', 'resolved', 'accepted', 'excluded')),
  resolution         text,
  resolved_by        uuid references auth.users(id),
  resolved_at        timestamptz,
  first_run_id       uuid references silver.validation_runs(id),
  last_run_id        uuid references silver.validation_runs(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (budget_version_id, fingerprint)
);
create index on silver.validation_issues (organization_id, budget_version_id, status, severity);
create trigger trg_vi_touch before update on silver.validation_issues for each row execute function core.touch_updated_at();

-- ---------------------------------------------------------------- SILVER: intercompañía
create table silver.intercompany_matches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  budget_version_id uuid not null references core.budget_versions(id),
  validation_run_id uuid not null references silver.validation_runs(id),
  ic_reference      text not null,
  period_code       text,
  seller_company_id uuid references core.companies(id),
  buyer_company_id  uuid references core.companies(id),
  seller_line_id    uuid references silver.normalized_budget_lines(id),
  buyer_line_id     uuid references silver.normalized_budget_lines(id),
  seller_amount     numeric(24, 6),   -- moneda de presentación
  buyer_amount      numeric(24, 6),
  difference        numeric(24, 6),
  tolerance         numeric(24, 6),
  status            text not null check (status in ('matched', 'mismatch', 'unmatched', 'accepted_difference')),
  created_at        timestamptz not null default now(),
  unique (validation_run_id, ic_reference)   -- instantánea inmutable por corrida: los asientos publicados la referencian
);
create index on silver.intercompany_matches (budget_version_id, ic_reference);

-- Conciliaciones vigentes = las de la última corrida de validación de cada versión
create view silver.current_intercompany_matches with (security_invoker = true) as
select m.* from silver.intercompany_matches m
where m.validation_run_id = (
  select r.id from silver.validation_runs r where r.budget_version_id = m.budget_version_id order by r.started_at desc, r.id desc limit 1);

-- Aceptaciones explícitas de diferencias IC (sobreviven a la revalidación solo si los importes no cambian)
create table silver.intercompany_acceptances (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  budget_version_id uuid not null references core.budget_versions(id),
  ic_reference      text not null,
  seller_line_hash  char(64) not null,
  buyer_line_hash   char(64) not null,
  reason            text not null,
  approved_by       uuid not null references auth.users(id),
  approved_at       timestamptz not null default now(),
  unique (budget_version_id, ic_reference)
);
