/** Traducciones de términos técnicos a lenguaje de negocio para la interfaz. */

export const ENTRY_LABEL: Record<string, string> = {
  translation: 'Conversión a moneda del grupo',
  elimination: 'Eliminación intercompañía',
  cta: 'Ajuste por conversión',
  adjustment: 'Ajuste aprobado',
};

export const RATE_LABEL: Record<string, string> = {
  average: 'promedio', closing: 'de cierre', historical: 'histórica', identity: 'misma moneda',
};

export const COMPONENT_LABEL: Record<string, string> = {
  revenue: 'Ingresos', costs: 'Costos', opex: 'Gastos operativos', ebitda: 'EBITDA', ebit: 'EBIT', nopat: 'NOPAT',
  depreciation_amortization: 'Depreciación y amortización', interest: 'Gasto financiero', ic_differences: 'Diferencias intercompañía',
  income_tax: 'Impuesto sobre la renta', invested_capital: 'Capital invertido promedio', capital_employed: 'Capital empleado promedio',
  opening: 'Saldo de apertura', closing: 'Saldo de cierre', equity: 'Patrimonio', debt: 'Deuda financiera', wacc: 'WACC',
  cost_of_equity: 'Costo del patrimonio', cost_of_debt: 'Costo de la deuda', tax_rate: 'Tasa impositiva', nopat_tax_rate: 'Tasa impositiva',
  contribution: 'Contribución de la empresa', group_revenue: 'Ingresos consolidados del grupo',
};
const RATIO_COMPONENTS = new Set(['wacc', 'cost_of_equity', 'cost_of_debt', 'tax_rate', 'nopat_tax_rate']);
export const isRatioComponent = (k: string) => RATIO_COMPONENTS.has(k);

export const TOOL_LABEL: Record<string, string> = {
  list_available_metrics: 'Catálogo de indicadores', list_dimensions: 'Catálogo de dimensiones', get_metric_definition: 'Definición del indicador',
  query_financial_metrics: 'Consulta de indicadores', compare_budget_versions: 'Comparación entre versiones', get_budget_variances: 'Desviaciones por empresa',
  get_consolidation_details: 'Detalle de la consolidación', get_validation_issues: 'Incidencias de calidad', get_lineage: 'Origen de la cifra',
  create_dashboard_widget: 'Nuevo widget', update_dashboard_widget: 'Cambio de widget', remove_dashboard_widget: 'Eliminación de widget',
  create_scenario: 'Simulación', run_scenario: 'Resultado de simulación',
};

export const ASSUMPTION_LABEL: Record<string, string> = {
  revenue_growth: 'crecimiento de ingresos', cost_increase: 'incremento de costos', opex_reduction: 'reducción de gastos operativos',
  fx_change: 'variación cambiaria', additional_investment: 'inversión adicional', operating_yield: 'rendimiento operativo',
  cost_of_capital: 'costo de capital', tax_rate: 'tasa impositiva',
};

/** Reemplaza identificadores técnicos en una fórmula por sus nombres de negocio. */
export function humanizeFormula(f: string): string {
  return f.replace(/[a-z]+(?:_[a-z]+)+/g, (k) => ASSUMPTION_LABEL[k] ?? COMPONENT_LABEL[k] ?? k.replace(/_/g, ' '));
}

export const PARAMETER_LABEL: Record<string, string> = {
  nopat_tax_rate: 'Tasa impositiva para NOPAT', cost_of_equity: 'Costo del patrimonio (Ke)', cost_of_debt: 'Costo de la deuda (Kd)',
  ic_tolerance_abs: 'Tolerancia de conciliación intercompañía (monto)', ic_tolerance_pct: 'Tolerancia de conciliación intercompañía (porcentaje)',
};
