# Capa semántica

Paquete: `packages/semantic-engine`. Adaptador PostgreSQL: `apps/api/src/services/semantic-adapter.ts` (contrato `FinancialQueryAdapter`, sustituible por Fabric).

## API

`POST /api/semantic/query` — contrato `SemanticQueryRequest` (Zod, `.strict()`: campos no previstos se rechazan).

```json
{ "metrics": ["roic", "eva"], "dimensions": ["company"],
  "filters": { "period": "2027", "version": "approved", "compare_to": "PRES-2027-V1", "companies": ["ALT-ALIM"], "countries": ["GT"] },
  "sort": { "field": "eva", "direction": "desc" }, "limit": 50 }
```

Respuesta (`SemanticQueryResponse`): `query_id`, `period`, `budget_version_id/code/kind`, `compare_version_code`, `run_id`, `run_status`, `currency`, `data_nature` (`official`/`projection`), `metrics[]` (`metric_id`, `metric_version`, fórmula, unidad, `certification_status`), `rows[]` (valor, estado, faltantes, comparación y variación), `certification_status`, `lineage_reference` (`query:<id>/run:<id>`), `warnings`.

## Pasos de ejecución

1. Validación Zod → 2. catálogo (métrica existe y tiene versión aprobada) → 3. compatibilidad métrica–dimensión (`semantic.metric_dimensions`) → 4. autorización por empresa (filtros ⊆ empresas accesibles; cifras de grupo solo con `all_companies`) → 5. resolución de versión (`approved` = presupuesto publicado más reciente) y corrida (publicada > aprobada > lista para revisión; certificada solo si está publicada) → 6. lectura de `gold.consolidated_financials` **bajo RLS** → 7. cálculo con las estrategias registradas del motor financiero → 8. registro en `semantic.query_executions` y `audit.data_lineage`.

Límite de tiempo: 10 s por consulta (y `statement_timeout` 15 s por transacción de usuario). Límite de filas: 500.

## Dimensiones

`company`, `country` (base individual, antes de eliminaciones), `period` (mensual, consolidado), `account` (cuenta corporativa). Máximo 2.

## Sinónimos

`semantic.synonyms` (español): "ventas" → revenue, "utilidad operativa" → ebit, "costo de capital" → wacc, "empresas" → company, "barras" → bar, etc. Usados por el resolvedor de términos de la IA (`resolveTerms`).

## Gobierno

Las fórmulas oficiales viven en `semantic.metric_versions` con estado `draft/approved/retired` (índice único: una aprobada por métrica). La IA no tiene herramienta para crear o aprobar fórmulas.
