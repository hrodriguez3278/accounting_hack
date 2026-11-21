-- NEXORA AI · 0500 · Row Level Security
-- Modelo: el rol `authenticated` solo LEE (la API ejecuta las lecturas de usuario con SET LOCAL ROLE authenticated
-- y request.jwt.claims, de modo que RLS se aplica también en el backend). Las escrituras pasan por la API con
-- autorización explícita. `anon` no tiene acceso a ningún esquema interno.

do $$
declare s text; t record;
begin
  foreach s in array array['core','bronze','silver','gold','semantic','ai','dashboards','scenarios','audit'] loop
    execute format('revoke all on schema %I from public, anon', s);
    execute format('grant usage on schema %I to authenticated', s);
    for t in select tablename from pg_tables where schemaname = s loop
      execute format('alter table %I.%I enable row level security', s, t.tablename);
      execute format('revoke all on %I.%I from public, anon, authenticated', s, t.tablename);
      execute format('grant select on %I.%I to authenticated', s, t.tablename);
    end loop;
  end loop;
end $$;

grant select on silver.current_intercompany_matches to authenticated;

grant execute on function core.is_member(uuid), core.has_all_companies(uuid), core.can_access_company(uuid),
  core.has_permission(uuid, text) to authenticated;

-- ---------------------------------------------------------------- catálogos globales (no sensibles)
create policy read_all on core.currencies for select to authenticated using (true);
create policy read_all on core.countries for select to authenticated using (true);
create policy read_all on core.roles for select to authenticated using (true);
create policy read_all on core.permissions for select to authenticated using (true);
create policy read_all on core.role_permissions for select to authenticated using (true);
create policy read_all on silver.validation_rules for select to authenticated using (true);
create policy read_all on semantic.metrics for select to authenticated using (true);
create policy read_all on semantic.metric_versions for select to authenticated using (true);
create policy read_all on semantic.dimensions for select to authenticated using (true);
create policy read_all on semantic.metric_dimensions for select to authenticated using (true);
create policy read_all on semantic.semantic_relationships for select to authenticated using (true);
create policy read_all on semantic.synonyms for select to authenticated using (true);

-- ---------------------------------------------------------------- core
create policy member_read on core.organizations for select to authenticated using (core.is_member(id));
create policy company_read on core.companies for select to authenticated using (core.can_access_company(id));
create policy member_read on core.fiscal_periods for select to authenticated using (core.is_member(organization_id));
create policy member_read on core.budget_versions for select to authenticated using (core.is_member(organization_id));
create policy member_read on core.financial_parameters for select to authenticated using (core.is_member(organization_id));
create policy self_or_admin on core.organization_members for select to authenticated
  using (user_id = auth.uid() or core.has_permission(organization_id, 'org.admin'));
create policy self_or_admin on core.company_access for select to authenticated
  using (user_id = auth.uid() or core.has_permission(organization_id, 'org.admin'));
create policy self_or_colleague on core.users_profiles for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from core.organization_members m where m.user_id = users_profiles.user_id and core.is_member(m.organization_id)));

-- ---------------------------------------------------------------- bronze / silver (por empresa)
create policy company_read on bronze.column_mappings for select to authenticated using (core.can_access_company(company_id));
create policy company_read on bronze.source_files for select to authenticated using (core.can_access_company(company_id));
create policy company_read on bronze.ingestion_batches for select to authenticated using (core.can_access_company(company_id));
create policy company_read on bronze.raw_budget_rows for select to authenticated
  using (exists (select 1 from bronze.source_files f where f.id = source_file_id and core.can_access_company(f.company_id)));
create policy member_read on silver.accounts for select to authenticated using (core.is_member(organization_id));
create policy company_read on silver.company_accounts for select to authenticated using (core.can_access_company(company_id));
create policy company_read on silver.account_mappings for select to authenticated using (core.can_access_company(company_id));
create policy member_read on silver.exchange_rates for select to authenticated using (core.is_member(organization_id));
create policy company_read on silver.normalized_budget_lines for select to authenticated using (core.can_access_company(company_id));
create policy member_read on silver.validation_runs for select to authenticated using (core.is_member(organization_id));
create policy company_read on silver.validation_issues for select to authenticated
  using (core.is_member(organization_id) and (company_id is null and core.has_all_companies(organization_id) or core.can_access_company(company_id)));
create policy ic_read on silver.intercompany_matches for select to authenticated
  using (core.can_access_company(seller_company_id) or core.can_access_company(buyer_company_id));
create policy member_read on silver.intercompany_acceptances for select to authenticated using (core.has_all_companies(organization_id));

-- ---------------------------------------------------------------- gold
create policy member_read on gold.consolidation_runs for select to authenticated using (core.is_member(organization_id));
create policy member_read on gold.consolidation_run_inputs for select to authenticated
  using (exists (select 1 from gold.consolidation_runs r where r.id = run_id and core.is_member(r.organization_id)));
create policy company_read on gold.consolidation_adjustments for select to authenticated using (core.can_access_company(company_id));
create policy company_read on gold.consolidation_entries for select to authenticated using (core.can_access_company(company_id));
create policy company_read on gold.consolidated_financials for select to authenticated using (core.can_access_company(company_id));
-- Cifras de grupo solo para miembros con acceso a todas las empresas; cifras por empresa según acceso
create policy scoped_read on gold.financial_metric_results for select to authenticated
  using (
    (scope = 'company' and core.can_access_company(company_id))
    or (scope = 'group' and exists (select 1 from gold.consolidation_runs r where r.id = run_id and core.has_all_companies(r.organization_id)))
  );

-- ---------------------------------------------------------------- semantic / ai
create policy own_or_auditor on semantic.query_executions for select to authenticated
  using (user_id = auth.uid() or core.has_permission(organization_id, 'audit.read'));
create policy owner_read on ai.conversations for select to authenticated using (user_id = auth.uid());
create policy owner_read on ai.messages for select to authenticated
  using (exists (select 1 from ai.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
create policy owner_or_auditor on ai.tool_executions for select to authenticated
  using (user_id = auth.uid() or core.has_permission(organization_id, 'audit.read'));
create policy owner_read on ai.analysis_results for select to authenticated
  using (exists (select 1 from ai.messages m join ai.conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.user_id = auth.uid()));

-- ---------------------------------------------------------------- dashboards
create or replace function dashboards.can_view(p_dashboard uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from dashboards.dashboards d
    where d.id = p_dashboard and core.is_member(d.organization_id)
      and (d.owner_id = auth.uid() or exists (
        select 1 from dashboards.dashboard_shares s where s.dashboard_id = d.id and s.user_id = auth.uid()))
  );
$$;
revoke all on function dashboards.can_view(uuid) from public, anon;
grant execute on function dashboards.can_view(uuid) to authenticated;

create policy viewer_read on dashboards.dashboards for select to authenticated using (dashboards.can_view(id));
create policy viewer_read on dashboards.widgets for select to authenticated using (dashboards.can_view(dashboard_id));
create policy viewer_read on dashboards.dashboard_versions for select to authenticated using (dashboards.can_view(dashboard_id));
create policy viewer_read on dashboards.dashboard_shares for select to authenticated using (dashboards.can_view(dashboard_id));
create policy viewer_read on dashboards.pending_changes for select to authenticated using (dashboards.can_view(dashboard_id));

-- ---------------------------------------------------------------- scenarios / audit
create policy member_read on scenarios.scenarios for select to authenticated
  using (core.is_member(organization_id) and (created_by = auth.uid() or core.has_all_companies(organization_id)));
create policy member_read on scenarios.scenario_assumptions for select to authenticated
  using (exists (select 1 from scenarios.scenarios s where s.id = scenario_id and core.is_member(s.organization_id)
                 and (s.created_by = auth.uid() or core.has_all_companies(s.organization_id))));
create policy member_read on scenarios.scenario_results for select to authenticated
  using (exists (select 1 from scenarios.scenarios s where s.id = scenario_id and core.is_member(s.organization_id)
                 and (s.created_by = auth.uid() or core.has_all_companies(s.organization_id))));
create policy auditor_read on audit.audit_events for select to authenticated using (core.has_permission(organization_id, 'audit.read'));
create policy auditor_read on audit.approval_events for select to authenticated using (core.has_permission(organization_id, 'audit.read'));
create policy auditor_read on audit.data_lineage for select to authenticated using (core.has_permission(organization_id, 'audit.read'));
