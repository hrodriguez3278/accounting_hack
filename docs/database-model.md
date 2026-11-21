# Modelo de datos (Supabase PostgreSQL 17)

Migraciones en `supabase/migrations` (orden numérico). Semillas en `supabase/seeds`: `10_reference.sql` (catálogos, reglas, métricas) y `20_demo_group.sql` (generado, datos DEMO ficticios).

| Esquema | Tablas | Notas |
|---|---|---|
| `core` | organizations, companies, countries, currencies, fiscal_periods, budget_versions, financial_parameters, users_profiles, roles, permissions, role_permissions, organization_members, company_access | Funciones de autorización `is_member`, `has_all_companies`, `can_access_company`, `has_permission` (security definer) |
| `bronze` | column_mappings, source_files, ingestion_batches, raw_budget_rows | `source_files` y `raw_budget_rows` inmutables por trigger. `source_records` del enunciado se fusionó con `raw_budget_rows` (ADR-004) |
| `silver` | accounts, company_accounts, account_mappings, exchange_rates, normalized_budget_lines, validation_rules, validation_runs, validation_issues, intercompany_matches, intercompany_acceptances; vista `current_intercompany_matches` | `intercompany_matches` es una instantánea por corrida de validación (los asientos publicados la referencian). `intercompany_transactions` = líneas con cuenta IC (no tabla aparte) |
| `gold` | consolidation_runs, consolidation_run_inputs, consolidation_adjustments, consolidation_entries, consolidated_financials, financial_metric_results | Trigger de transiciones de estado y de protección de corridas finalizadas. `budget_variances` se calcula bajo demanda (puente determinista) en lugar de persistirse |
| `semantic` | metrics, metric_versions, dimensions, metric_dimensions, semantic_relationships, synonyms, query_executions | Una sola versión aprobada por métrica |
| `ai` | conversations, messages, tool_executions, analysis_results | |
| `dashboards` | dashboards, widgets, dashboard_versions, dashboard_shares, pending_changes | `widget_versions` del enunciado → `dashboard_versions` con instantánea completa (ADR-006) |
| `scenarios` | scenarios, scenario_assumptions, scenario_results | |
| `audit` | audit_events, approval_events, data_lineage | Solo inserción (trigger) |

## Cadena de procedencia (por claves foráneas)

```
financial_metric_results.run_id ─► consolidation_runs ─► consolidation_run_inputs ─► ingestion_batches ─► source_files (sha256, storage_path)
consolidated_financials (run, company, account, period)
consolidation_entries.source_line_id ─► normalized_budget_lines.raw_row_id ─► raw_budget_rows.source_file_id ─► source_files
consolidation_entries.rate_id ─► exchange_rates     consolidation_entries.ic_match_id ─► intercompany_matches
consolidation_entries.adjustment_id ─► consolidation_adjustments
query_executions.run_ids[] + audit.data_lineage (query → run)
```

## Exposición

`config.toml` expone solo `public` y `graphql_public` por la Data API; ningún dato financiero vive allí. El navegador solo usa Supabase Auth. Bucket privado `budget-files` sin políticas de acceso para `anon`/`authenticated` (solo el servidor con clave secreta).
