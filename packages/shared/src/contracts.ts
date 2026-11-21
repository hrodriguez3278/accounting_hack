import { z } from 'zod';
import { RateType } from './domain.js';

const Code = z.string().regex(/^[a-z_]{2,40}$/);
const Uuid = z.string().uuid();

// ---------------------------------------------------------------- Data Hub
export const CANONICAL_FIELDS = [
  'account_code', 'account_name', 'period', 'amount', 'currency', 'counterparty_code', 'ic_reference', 'company_code',
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export const REQUIRED_FIELDS: CanonicalField[] = ['account_code', 'period', 'amount'];

export const PeriodFormat = z.enum(['YYYY-MM', 'YYYYMM', 'MM/YYYY', 'MON-YYYY']);
export type PeriodFormat = z.infer<typeof PeriodFormat>;

export const ColumnMappingConfig = z.object({
  columns: z.object({
    account_code: z.string().min(1).max(120),
    account_name: z.string().max(120).optional(),
    period: z.string().min(1).max(120),
    amount: z.string().min(1).max(120),
    currency: z.string().max(120).optional(),
    counterparty_code: z.string().max(120).optional(),
    ic_reference: z.string().max(120).optional(),
    company_code: z.string().max(120).optional(),
  }),
  period_format: PeriodFormat,
  decimal_separator: z.enum(['.', ',']),
  thousands_separator: z.enum(['', '.', ',', ' ']).default(''),
  delimiter: z.enum([',', ';', '\t', '|']).optional(),
  sheet: z.string().max(80).optional(),
  default_currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).refine((c) => c.decimal_separator !== c.thousands_separator, {
  message: 'El separador decimal y el de miles no pueden ser iguales',
});
export type ColumnMappingConfig = z.infer<typeof ColumnMappingConfig>;

export const CreateBatchRequest = z.object({
  company_id: Uuid,
  budget_version_id: Uuid,
  source_file_id: Uuid,
  mapping: ColumnMappingConfig,
  save_mapping_as: z.string().min(1).max(80).optional(),
});
export type CreateBatchRequest = z.infer<typeof CreateBatchRequest>;

// ---------------------------------------------------------------- Calidad
export const ResolutionAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('exclude_line'), reason: z.string().min(5).max(500) }),
  z.object({
    action: z.literal('correct_field'),
    field: z.enum(['currency', 'period_code', 'counterparty_code', 'account_code', 'amount']),
    value: z.string().max(60),
    reason: z.string().min(5).max(500),
  }),
  z.object({ action: z.literal('accept'), reason: z.string().min(5).max(500) }),
  z.object({ action: z.literal('accept_ic_difference'), reason: z.string().min(5).max(500) }),
]);
export type ResolutionAction = z.infer<typeof ResolutionAction>;

export const CreateMappingRequest = z.object({
  company_id: Uuid,
  company_account_code: z.string().min(1).max(60),
  account_code: z.string().min(1).max(20),
});

export const CreateRateRequest = z.object({
  from_currency: z.string().regex(/^[A-Z]{3}$/),
  to_currency: z.string().regex(/^[A-Z]{3}$/),
  period_code: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
  rate_type: RateType,
  scenario: z.string().min(2).max(40),
  rate: z.string().regex(/^\d+(\.\d{1,10})?$/),
  source: z.string().min(3).max(200),
});

// ---------------------------------------------------------------- Capa semántica
export const DimensionCode = z.enum(['company', 'country', 'period', 'account']);
export type DimensionCode = z.infer<typeof DimensionCode>;

export const SemanticFilters = z.object({
  /** Ejercicio fiscal, p. ej. "2027". */
  period: z.string().regex(/^\d{4}$/),
  /** Código de versión presupuestaria o alias "approved" (= versión presupuestaria publicada más reciente). */
  version: z.string().min(2).max(40).default('approved'),
  /** Versión de comparación para variaciones y efecto cambiario. */
  compare_to: z.string().min(2).max(40).optional(),
  companies: z.array(z.string().max(20)).max(50).optional(),
  countries: z.array(z.string().length(2)).max(20).optional(),
  months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(12).optional(),
});
export type SemanticFilters = z.infer<typeof SemanticFilters>;

export const SemanticQueryRequest = z.object({
  metrics: z.array(Code).min(1).max(8),
  dimensions: z.array(DimensionCode).max(2).default([]),
  filters: SemanticFilters,
  sort: z.object({ field: z.string().max(40), direction: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().min(1).max(500).default(200),
}).strict();
export type SemanticQueryRequest = z.infer<typeof SemanticQueryRequest>;

export const MetricValue = z.object({
  value: z.string().nullable(),          // decimal serializado; null = no calculable
  status: z.enum(['calculated', 'not_calculable']),
  missing: z.array(z.string()).default([]),
  compare_value: z.string().nullable().optional(),
  variance_abs: z.string().nullable().optional(),
  variance_pct: z.string().nullable().optional(),
});
export type MetricValue = z.infer<typeof MetricValue>;

export const SemanticRow = z.object({
  key: z.string(),
  dimensions: z.record(z.string(), z.string()),
  labels: z.record(z.string(), z.string()),
  values: z.record(z.string(), MetricValue),
});
export type SemanticRow = z.infer<typeof SemanticRow>;

export const MetricMeta = z.object({
  metric_id: z.string(),
  metric_version: z.number().int(),
  name: z.string(),
  formula: z.string(),
  unit: z.enum(['currency', 'ratio']),
  certification_status: z.enum(['certified', 'not_certified']),
});

export const SemanticQueryResponse = z.object({
  query_id: Uuid,
  period: z.string(),
  budget_version_id: Uuid,
  budget_version_code: z.string(),
  budget_version_kind: z.string(),
  compare_version_code: z.string().nullable(),
  run_id: Uuid,
  run_status: z.string(),
  currency: z.string(),
  data_nature: z.enum(['official', 'projection', 'simulation', 'assumption']),
  metrics: z.array(MetricMeta),
  dimensions: z.array(z.string()),
  rows: z.array(SemanticRow),
  certification_status: z.enum(['certified', 'not_certified']),
  lineage_reference: z.string(),
  warnings: z.array(z.string()),
  computed_at: z.string(),
});
export type SemanticQueryResponse = z.infer<typeof SemanticQueryResponse>;

// ---------------------------------------------------------------- Dashboards (especificación declarativa, sin código)
export const WidgetType = z.enum([
  'kpi', 'bar', 'line', 'area', 'donut', 'stacked_bar', 'waterfall', 'table', 'comparison_table', 'variance', 'heatmap', 'insight',
]);
export type WidgetType = z.infer<typeof WidgetType>;

/** Texto plano seguro: sin etiquetas, sin llaves de plantilla ni secuencias javascript:. */
const SafeText = (max: number) =>
  z.string().max(max).refine((s) => !/[<>{}]|javascript:|on\w+\s*=/i.test(s), 'Texto con caracteres no permitidos');

export const WidgetSpec = z.object({
  title: SafeText(120).pipe(z.string().min(1)),
  type: WidgetType,
  metric_ids: z.array(Code).min(1).max(4),
  dimensions: z.array(DimensionCode).max(2).default([]),
  filters: z.object({
    period: z.string().regex(/^\d{4}$/).optional(),
    version: z.string().max(40).optional(),
    compare_to: z.string().max(40).optional(),
    companies: z.array(z.string().max(20)).max(50).optional(),
    countries: z.array(z.string().length(2)).max(20).optional(),
  }).strict().default({}),
  sort: z.object({ field: z.string().max(40), direction: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  size: z.enum(['sm', 'md', 'lg', 'xl']).default('md'),
  options: z.object({
    show_legend: z.boolean().optional(),
    show_labels: z.boolean().optional(),
    highlight: z.string().max(20).optional(),
    note: SafeText(280).optional(),
  }).strict().default({}),
}).strict();
export type WidgetSpec = z.infer<typeof WidgetSpec>;

export const DashboardAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_widget'), widget: WidgetSpec }),
  z.object({ action: z.literal('update_widget'), widget_id: Uuid, changes: WidgetSpec.partial() }),
  z.object({ action: z.literal('remove_widget'), widget_id: Uuid }),
  z.object({ action: z.literal('reorder_widgets'), order: z.array(Uuid).max(60) }),
  z.object({ action: z.literal('set_global_filters'), filters: SemanticFilters.partial() }),
  z.object({ action: z.literal('rename_dashboard'), name: SafeText(120).pipe(z.string().min(1)) }),
]);
export type DashboardAction = z.infer<typeof DashboardAction>;

export const DashboardPlan = z.object({
  actions: z.array(DashboardAction).max(12),
  explanation: SafeText(600),
});
export type DashboardPlan = z.infer<typeof DashboardPlan>;

// ---------------------------------------------------------------- Escenarios
export const SCENARIO_ASSUMPTIONS = {
  revenue_growth: 'Crecimiento de ingresos (fracción, p. ej. 0.05 = +5 %)',
  cost_increase: 'Incremento de costo de ventas (fracción)',
  opex_reduction: 'Reducción de gastos operativos (fracción)',
  fx_change: 'Variación de tasas de cambio de monedas locales frente a la moneda del grupo (fracción; +0.02 = moneda local 2 % más fuerte)',
  additional_investment: 'Inversión adicional en capital invertido (moneda del grupo)',
  cost_of_capital: 'WACC supuesto (fracción). Si se omite se usa el WACC calculado',
  tax_rate: 'Tasa impositiva para NOPAT (fracción). Si se omite se usa el parámetro aprobado',
  operating_yield: 'Rendimiento operativo proyectado sobre la inversión adicional (fracción de EBIT incremental)',
} as const;
export type ScenarioAssumptionCode = keyof typeof SCENARIO_ASSUMPTIONS;

const Fraction = z.string().regex(/^-?\d+(\.\d{1,10})?$/);
export const ScenarioAssumptions = z.object({
  revenue_growth: Fraction.optional(),
  cost_increase: Fraction.optional(),
  opex_reduction: Fraction.optional(),
  fx_change: Fraction.optional(),
  additional_investment: Fraction.optional(),
  cost_of_capital: Fraction.optional(),
  tax_rate: Fraction.optional(),
  operating_yield: Fraction.optional(),
}).strict();
export type ScenarioAssumptions = z.infer<typeof ScenarioAssumptions>;

export const CreateScenarioRequest = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(500).default(''),
  base_version: z.string().min(2).max(40).default('approved'),
  fiscal_year: z.string().regex(/^\d{4}$/),
  assumptions: ScenarioAssumptions,
});
export type CreateScenarioRequest = z.infer<typeof CreateScenarioRequest>;
