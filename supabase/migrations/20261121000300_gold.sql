-- NEXORA AI · 0300 · Gold: consolidaciones reproducibles, asientos explícitos, métricas certificadas

create table gold.consolidation_runs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  budget_version_id     uuid not null references core.budget_versions(id),
  fiscal_year           smallint not null,
  presentation_currency char(3) not null references core.currencies(code),
  status                text not null default 'draft' check (status in (
                          'draft', 'validating', 'blocked', 'ready_for_review', 'approved', 'published', 'failed', 'superseded')),
  inputs_hash           char(64),        -- SHA-256 de líneas, tasas, mapeos, ajustes, parámetros y versión de reglas
  rules_version         text not null,
  engine_version        text not null,
  parameters            jsonb not null default '{}'::jsonb,
  rates_applied         jsonb not null default '[]'::jsonb,
  summary               jsonb not null default '{}'::jsonb,
  blocking_issues       integer not null default 0,
  error                 text,
  created_by            uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  finished_at           timestamptz,
  approved_by           uuid references auth.users(id),
  approved_at           timestamptz,
  published_by          uuid references auth.users(id),
  published_at          timestamptz
);
create index on gold.consolidation_runs (organization_id, budget_version_id, created_at desc);
-- Solo puede existir una consolidación publicada por versión
create unique index consolidation_one_published on gold.consolidation_runs (budget_version_id) where status = 'published';

create table gold.consolidation_run_inputs (
  run_id   uuid not null references gold.consolidation_runs(id) on delete cascade,
  batch_id uuid not null references bronze.ingestion_batches(id),
  primary key (run_id, batch_id)
);

create table gold.consolidation_adjustments (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  budget_version_id uuid not null references core.budget_versions(id),
  company_id        uuid not null references core.companies(id),
  account_id        uuid not null references silver.accounts(id),
  period_code       text not null,
  amount            numeric(24, 6) not null,  -- en moneda de presentación, convención de signo natural de la cuenta
  adjustment_type   text not null check (adjustment_type in ('unrealized_profit', 'reclassification', 'manual', 'ic_difference')),
  description       text not null,
  status            text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  approved_by       uuid references auth.users(id),
  approved_at       timestamptz
);

create table gold.consolidation_entries (
  id             bigint generated always as identity primary key,
  run_id         uuid not null references gold.consolidation_runs(id) on delete cascade,
  company_id     uuid not null references core.companies(id),
  account_id     uuid not null references silver.accounts(id),
  period_code    text not null,
  entry_type     text not null check (entry_type in ('translation', 'elimination', 'cta', 'adjustment')),
  source_line_id uuid references silver.normalized_budget_lines(id),
  ic_match_id    uuid references silver.intercompany_matches(id),
  adjustment_id  uuid references gold.consolidation_adjustments(id),
  local_amount   numeric(24, 6),
  local_currency char(3),
  rate           numeric(20, 10),
  rate_type      text check (rate_type in ('average', 'closing', 'historical', 'identity')),
  rate_id        uuid references silver.exchange_rates(id),
  group_amount   numeric(24, 6) not null,
  description    text not null
);
create index on gold.consolidation_entries (run_id, account_id, period_code);
create index on gold.consolidation_entries (source_line_id);

create table gold.consolidated_financials (
  run_id             uuid not null references gold.consolidation_runs(id) on delete cascade,
  company_id         uuid not null references core.companies(id),
  account_id         uuid not null references silver.accounts(id),
  period_code        text not null,
  translated_amount  numeric(24, 6) not null default 0,
  elimination_amount numeric(24, 6) not null default 0,
  cta_amount         numeric(24, 6) not null default 0,
  adjustment_amount  numeric(24, 6) not null default 0,
  total_amount       numeric(24, 6) not null,
  primary key (run_id, company_id, account_id, period_code)
);

create table gold.financial_metric_results (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references gold.consolidation_runs(id) on delete cascade,
  metric_code    text not null,
  metric_version integer not null,
  scope          text not null check (scope in ('group', 'company')),
  company_id     uuid references core.companies(id),
  period_label   text not null,     -- p.ej. FY2027
  value          numeric(30, 12),
  unit           text not null check (unit in ('currency', 'ratio')),
  status         text not null check (status in ('calculated', 'not_calculable')),
  missing        jsonb not null default '[]'::jsonb,
  components     jsonb not null default '{}'::jsonb,
  computed_at    timestamptz not null default now(),
  check ((scope = 'group') = (company_id is null)),
  check ((status = 'calculated') = (value is not null))
);
create unique index metric_results_unique on gold.financial_metric_results
  (run_id, metric_code, scope, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), period_label);

-- Protección: las corridas aprobadas/publicadas no admiten cambios en sus resultados
create or replace function gold.protect_finalized_run() returns trigger
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from gold.consolidation_runs where id = coalesce(new.run_id, old.run_id);
  if v_status in ('approved', 'published', 'superseded') then
    raise exception 'La consolidación % está % y no admite modificaciones', coalesce(new.run_id, old.run_id), v_status
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_entries_protect before insert or update or delete on gold.consolidation_entries
  for each row execute function gold.protect_finalized_run();
create trigger trg_financials_protect before insert or update or delete on gold.consolidated_financials
  for each row execute function gold.protect_finalized_run();
create trigger trg_metrics_protect before insert or update or delete on gold.financial_metric_results
  for each row execute function gold.protect_finalized_run();

-- Transiciones de estado autorizadas
create or replace function gold.check_run_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = old.status then
    if old.status in ('published', 'superseded') and (new.inputs_hash is distinct from old.inputs_hash
        or new.summary is distinct from old.summary or new.parameters is distinct from old.parameters) then
      raise exception 'Una consolidación publicada es inmutable' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if not (
    (old.status = 'draft' and new.status in ('validating', 'failed')) or
    (old.status = 'validating' and new.status in ('blocked', 'ready_for_review', 'failed')) or
    (old.status = 'ready_for_review' and new.status in ('approved', 'blocked')) or
    (old.status = 'approved' and new.status in ('published')) or
    (old.status = 'published' and new.status in ('superseded'))
  ) then
    raise exception 'Transición de estado no autorizada: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_run_transition before update on gold.consolidation_runs
  for each row execute function gold.check_run_transition();
