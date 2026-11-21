import { z } from 'zod';
import { DimensionCode, ScenarioAssumptions, WidgetSpec } from '@nexora/shared';

const Version = z.string().min(2).max(40).describe('Código de versión (p.ej. PRES-2027-V2), o "approved" para el presupuesto publicado vigente');
const Period = z.string().regex(/^\d{4}$/).describe('Ejercicio fiscal, p.ej. "2027"');
const MetricCode = z.string().regex(/^[a-z_]{2,40}$/);

/**
 * Herramientas autorizadas del agente. No existe ninguna herramienta de SQL libre ni de aprobación/publicación:
 * las acciones financieras privilegiadas no pueden dispararse desde texto generado por un modelo.
 */
export const TOOL_SCHEMAS = {
  list_available_metrics: { description: 'Lista el catálogo de métricas gobernadas con su fórmula y unidad.', schema: z.object({}).strict() },
  list_dimensions: { description: 'Lista las dimensiones disponibles y su compatibilidad.', schema: z.object({}).strict() },
  get_metric_definition: { description: 'Devuelve la definición aprobada (fórmula, componentes, versión) de una métrica.',
    schema: z.object({ metric: MetricCode }).strict() },
  query_financial_metrics: {
    description: 'Consulta cifras certificadas vía la capa semántica. Única forma de obtener valores financieros.',
    schema: z.object({
      metrics: z.array(MetricCode).min(1).max(6),
      dimensions: z.array(DimensionCode).max(2).default([]),
      filters: z.object({ period: Period, version: Version.default('approved'), compare_to: Version.optional(),
        companies: z.array(z.string().max(20)).max(20).optional(), countries: z.array(z.string().length(2)).max(10).optional() }).strict(),
      sort: z.object({ field: z.string().max(40), direction: z.enum(['asc', 'desc']) }).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).strict(),
  },
  compare_budget_versions: {
    description: 'Puente de reconciliación determinista entre dos versiones (volumen, tipo de cambio, eliminaciones, ajustes, residual).',
    schema: z.object({ metric: z.enum(['revenue', 'costs', 'opex', 'ebitda', 'ebit', 'net_income']), version: Version, compare_to: Version, period: Period }).strict(),
  },
  get_budget_variances: {
    description: 'Variaciones absolutas y porcentuales de una métrica por empresa entre dos versiones.',
    schema: z.object({ metric: MetricCode, version: Version, compare_to: Version, period: Period }).strict(),
  },
  get_consolidation_details: {
    description: 'Estado de la consolidación de una versión: corrida, hash de entradas, eliminaciones IC y diferencias aceptadas.',
    schema: z.object({ version: Version, period: Period }).strict(),
  },
  get_validation_issues: {
    description: 'Incidencias de calidad de datos de una versión.',
    schema: z.object({ version: Version, period: Period, status: z.enum(['open', 'resolved', 'accepted', 'excluded']).optional() }).strict(),
  },
  get_lineage: {
    description: 'Procedencia de una métrica: fórmula, corrida, cuentas, archivos fuente.',
    schema: z.object({ metric: MetricCode, version: Version, period: Period, company: z.string().max(20).optional() }).strict(),
  },
  create_dashboard_widget: { description: 'Agrega un widget declarativo al dashboard activo.',
    schema: z.object({ widget: WidgetSpec }).strict() },
  update_dashboard_widget: { description: 'Modifica un widget del dashboard activo.',
    schema: z.object({ widget_id: z.string().uuid(), changes: WidgetSpec.partial() }).strict() },
  remove_dashboard_widget: { description: 'Elimina un widget del dashboard activo.', schema: z.object({ widget_id: z.string().uuid() }).strict() },
  create_scenario: {
    description: 'Crea y calcula un escenario de simulación (no modifica datos oficiales).',
    schema: z.object({ name: z.string().min(3).max(120), base_version: Version.default('approved'), fiscal_year: Period,
      assumptions: ScenarioAssumptions }).strict(),
  },
  run_scenario: { description: 'Obtiene los resultados calculados de un escenario existente.', schema: z.object({ scenario_id: z.string().uuid() }).strict() },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];
export const ANALYST_TOOLS: ToolName[] = TOOL_NAMES.filter((t) => !t.includes('dashboard_widget'));

/** JSON Schema apto para function calling (sin metadatos $schema). */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

export function toolJsonSchemas(names: ToolName[]) {
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: TOOL_SCHEMAS[name].description, parameters: jsonSchemaFor(TOOL_SCHEMAS[name].schema) },
  }));
}
