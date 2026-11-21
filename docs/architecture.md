# NEXORA AI — Arquitectura

> Principio rector: **cada cifra presentada debe poder reconstruirse y verificarse.**
> La IA interpreta intenciones y redacta; nunca calcula cifras oficiales.

## 1. Vista general

```
┌──────────────────────────── apps/web (Nuxt 4 · Vue 3 · Tailwind v4 · ECharts) ────────────────────────────┐
│ Overview · AI Dashboards · Financial Analyst · Consolidation · Data Hub · Data Quality · Scenario Lab ·   │
│ Audit & Lineage · Administration                                                                          │
│ Solo conoce: Supabase Auth (clave publicable) + REST de apps/api (Bearer JWT del usuario)                 │
└───────────────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                                │ HTTPS / JSON (contratos Zod de @nexora/shared)
┌───────────────────────────────────────────────▼───────────────────────────────────────────────────────────┐
│ apps/api (Node.js · Fastify · Zod · logging estructurado pino)                                             │
│  auth (verifica JWT) → authz (org/empresa/permiso) → módulos:                                              │
│  data-hub · data-quality · consolidation · semantic · dashboards · analyst · scenarios · audit · admin     │
└───────┬───────────────┬─────────────────┬──────────────────┬─────────────────┬──────────────────┬──────────┘
        │               │                 │                  │                 │                  │
 validation-engine financial-engine semantic-engine  dashboard-engine     ai-engine         database
 (reglas puras)   (traducción, IC,  (catálogo,        (spec declarativa,  (proveedores LLM,  (adaptadores:
                   CTA, métricas,    validación de      Zod, acciones,     tool calling,      Postgres,
                   varianzas,        consultas,         layout)            herramientas       Storage,
                   escenarios)       estrategias)                          autorizadas)       FinancialQuery)
        └───────────────┴─────────────────┴──────────────────┴─────────────────┴──────────────────┘
                                                │ SQL parametrizado (postgres.js)
┌───────────────────────────────────────────────▼───────────────────────────────────────────────────────────┐
│ Supabase local (PostgreSQL 17 · Auth · Storage)                                                            │
│ core · bronze · silver · gold · semantic · ai · dashboards · scenarios · audit   (RLS en todas las tablas) │
│ Bucket privado `budget-files` (archivos originales inmutables)                                             │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Módulos y responsabilidades

| Módulo | Paquete / ruta | Responsabilidad |
|---|---|---|
| Identity & Access | `apps/api/src/plugins/auth.ts`, `core.*`, RLS | Verificar JWT de Supabase, resolver membresía, rol y empresas autorizadas |
| Company Management | `apps/api/src/modules/admin` | Organizaciones, empresas, monedas, periodos, versiones |
| Data Hub | `apps/api/src/modules/data-hub`, `workers/ingestion` | Carga CSV/XLSX, hash SHA-256, Storage privado, mapeo de columnas, lotes idempotentes |
| Data Quality Engine | `packages/validation-engine` | Reglas configurables → `silver.validation_issues` |
| Financial Consolidation Engine | `packages/financial-engine`, `workers/consolidation` | Homologación, traducción, IC, CTA, ajustes, métricas, varianzas |
| Semantic Layer | `packages/semantic-engine`, `POST /api/semantic/query` | Único punto de consulta financiera (UI e IA) |
| AI Financial Analyst | `packages/ai-engine` | Agente con herramientas autorizadas; verificación de cifras citadas |
| AI Dashboard Studio | `packages/dashboard-engine` | Intent → spec declarativa validada → widgets persistidos |
| Scenario Lab | `packages/financial-engine/src/scenarios.ts` | Simulación sobre una consolidación base sin modificarla |
| Audit & Lineage | `audit.*`, `apps/api/src/modules/audit` | Eventos, aprobaciones y navegación de procedencia por FK |

## 3. Flujo de datos (Lakehouse lógico)

1. **Bronze** — `source_files` (+ objeto en Storage) y `raw_budget_rows` (JSON original por fila). Inmutables por trigger.
2. **Silver** — `normalized_budget_lines` (modelo canónico), homologación vía `account_mappings`, `exchange_rates`, `validation_issues`, `intercompany_matches`.
3. **Gold** — `consolidation_runs` → `consolidation_entries` (una por línea traducida, eliminación, CTA o ajuste) → `consolidated_financials` → `financial_metric_results`.

Cada entrada Gold referencia su línea Silver; cada línea Silver referencia su fila Bronze; cada fila Bronze referencia su archivo. La trazabilidad es por claves foráneas, no por texto.

## 4. Seguridad en capas

1. **Navegador**: solo clave publicable de Supabase; ninguna tabla financiera se expone vía Data API (`api.schemas = ["public"]`, y `public` no contiene datos).
2. **API**: verifica el JWT con Supabase Auth, resuelve membresía y permisos, valida entrada con Zod.
3. **Base de datos**: las lecturas de usuario se ejecutan con `SET LOCAL ROLE authenticated` + `request.jwt.claims`, por lo que **RLS se aplica también dentro del backend** (defensa en profundidad). Las escrituras del motor usan el rol privilegiado solo después de la autorización explícita.
4. **IA**: no recibe credenciales ni SQL; solo herramientas tipadas que llaman a la capa semántica con el contexto del usuario. El texto de archivos y mensajes se trata como dato no confiable.

## 5. Determinismo financiero

- Aritmética decimal (`decimal.js`, 34 dígitos) en motores; `numeric(24,6)` en base de datos.
- Tasas: resultado → promedio del periodo; balance → cierre del periodo; patrimonio → histórica. Ver `financial-rules.md`.
- `consolidation_runs.inputs_hash` = SHA-256 de líneas, tasas, mapeos, ajustes y versión de reglas. Dos corridas con el mismo hash deben producir los mismos resultados.
- Métricas no calculables se marcan `not_calculable` con la lista de componentes faltantes; nunca se sustituye por cero.

## 6. Preparación para Microsoft Fabric

Interfaces en `packages/database/src/adapters.ts`: `SourceDataAdapter`, `StorageAdapter`, `FinancialQueryAdapter`, `IngestionAdapter`. Implementación actual: Supabase/Postgres. La IA solo conoce la Semantic API; los dashboards solo su Query API. Plan en `docs/decisions.md` (ADR-007).

## 7. Despliegue

El proyecto corre **solo en local** (Supabase CLI + Docker). Cualquier publicación (Supabase hospedado, hosting web, dominios) debe ser provisionada y validada por el equipo de **Transformación Digital** de Íntegro; no se deben usar cuentas personales.
