import type { ScenarioAssumptions } from '@nexora/shared';
import { D, Decimal, toStr } from './decimal.js';
import { computeMetric, type Aggregate } from './metrics.js';

/**
 * Motor de escenarios. Fórmulas explícitas (docs/financial-rules.md §7):
 *   fx_R  = 1 + fx_change · (porción de ingresos en moneda extranjera)       (análogo para costos y opex)
 *   R'    = R · (1 + revenue_growth) · fx_R
 *   C'    = C · (1 + revenue_growth) · (1 + cost_increase) · fx_C            (costo de ventas variable)
 *   O'    = O · (1 − opex_reduction) · fx_O
 *   EBITDA' = R' − C' − O'
 *   EBIT'   = EBITDA' − D&A + additional_investment · operating_yield
 *   NOPAT'  = EBIT' · (1 − tax_rate)
 *   IC'     = IC_promedio + additional_investment ;  CE' = CE_promedio + additional_investment
 *   ROIC' = NOPAT'/IC' ; ROCE' = EBIT'/CE' ; EVA' = NOPAT' − IC' · WACC'   (WACC' = cost_of_capital o WACC base)
 * No modifica datos aprobados: opera sobre un agregado de la consolidación base.
 */
export interface ScenarioBase {
  aggregate: Aggregate;
  /** Porción (0..1) de cada categoría proveniente de empresas con moneda funcional distinta a la de presentación. */
  foreignShare: { revenue: Decimal; cogs: Decimal; opex: Decimal };
}

export interface ScenarioMetric {
  metricCode: string;
  unit: 'currency' | 'ratio';
  base: string | null;
  scenario: string | null;
  delta: string | null;
  status: 'calculated' | 'not_calculable';
  missing: string[];
}

export interface ScenarioResult {
  status: 'complete' | 'incomplete';
  missingAssumptions: string[];
  metrics: ScenarioMetric[];
  formulas: Record<string, string>;
}

const FORMULAS: Record<string, string> = {
  revenue: 'R · (1 + revenue_growth) · (1 + fx_change · porción extranjera)',
  costs: 'C · (1 + revenue_growth) · (1 + cost_increase) · (1 + fx_change · porción extranjera)',
  opex: 'O · (1 − opex_reduction) · (1 + fx_change · porción extranjera)',
  ebitda: "R' − C' − O'",
  ebit: "EBITDA' − D&A + inversión adicional · rendimiento operativo",
  nopat: "EBIT' · (1 − tasa impositiva)",
  invested_capital: 'capital invertido promedio + inversión adicional',
  capital_employed: 'capital empleado promedio + inversión adicional',
  roic: "NOPAT' / capital invertido'",
  roce: "EBIT' / capital empleado'",
  wacc: 'costo de capital supuesto o WACC base',
  eva: "NOPAT' − capital invertido' · WACC'",
};

export function runScenario(base: ScenarioBase, assumptions: ScenarioAssumptions): ScenarioResult {
  const a = base.aggregate;
  const n = (v: string | undefined, dflt = '0') => D(v ?? dflt);
  const g = n(assumptions.revenue_growth);
  const ci = n(assumptions.cost_increase);
  const orr = n(assumptions.opex_reduction);
  const fx = n(assumptions.fx_change);
  const inv = n(assumptions.additional_investment);
  const missingAssumptions: string[] = [];
  if (!inv.isZero() && assumptions.operating_yield === undefined) {
    missingAssumptions.push('operating_yield: rendimiento operativo esperado de la inversión adicional');
  }
  const yld = n(assumptions.operating_yield);

  const baseVals: Record<string, ReturnType<typeof computeMetric>> = {};
  for (const m of ['revenue', 'costs', 'opex', 'ebitda', 'ebit', 'nopat', 'invested_capital', 'capital_employed', 'roic', 'roce', 'wacc', 'eva']) {
    baseVals[m] = computeMetric(m, a);
  }
  const v = (m: string) => baseVals[m]!.value;
  const taxParam = a.params.nopat_tax_rate;
  const t = assumptions.tax_rate !== undefined ? D(assumptions.tax_rate) : taxParam;

  const fxR = D(1).plus(fx.times(base.foreignShare.revenue));
  const fxC = D(1).plus(fx.times(base.foreignShare.cogs));
  const fxO = D(1).plus(fx.times(base.foreignShare.opex));
  const R = v('revenue'), C = v('costs'), O = v('opex'), E0 = v('ebitda'), EBIT0 = v('ebit');
  const da = E0 && EBIT0 ? E0.minus(EBIT0) : null;

  const s: Record<string, Decimal | null> = {};
  const miss: Record<string, string[]> = {};
  s.revenue = R ? R.times(D(1).plus(g)).times(fxR) : null;
  s.costs = C ? C.times(D(1).plus(g)).times(D(1).plus(ci)).times(fxC) : null;
  s.opex = O ? O.times(D(1).minus(orr)).times(fxO) : null;
  s.ebitda = s.revenue && s.costs && s.opex ? s.revenue.minus(s.costs).minus(s.opex) : null;
  s.ebit = s.ebitda && da ? s.ebitda.minus(da).plus(inv.times(yld)) : null;
  if (!t) miss.nopat = ['Tasa impositiva (parámetro nopat_tax_rate o supuesto tax_rate)'];
  s.nopat = s.ebit && t ? s.ebit.times(D(1).minus(t)) : null;
  s.invested_capital = v('invested_capital') ? v('invested_capital')!.plus(inv) : null;
  s.capital_employed = v('capital_employed') ? v('capital_employed')!.plus(inv) : null;
  s.roic = s.nopat && s.invested_capital && !s.invested_capital.isZero() ? s.nopat.div(s.invested_capital) : null;
  s.roce = s.ebit && s.capital_employed && !s.capital_employed.isZero() ? s.ebit.div(s.capital_employed) : null;
  s.wacc = assumptions.cost_of_capital !== undefined ? D(assumptions.cost_of_capital) : v('wacc');
  s.eva = s.nopat && s.invested_capital && s.wacc ? s.nopat.minus(s.invested_capital.times(s.wacc)) : null;

  const metrics: ScenarioMetric[] = Object.keys(FORMULAS).map((code) => {
    const b = baseVals[code]!;
    const sv = missingAssumptions.length ? null : s[code] ?? null;
    const missing = [...b.missing, ...(miss[code] ?? []), ...missingAssumptions];
    return {
      metricCode: code,
      unit: ['roic', 'roce', 'wacc'].includes(code) ? 'ratio' : 'currency',
      base: b.value ? toStr(b.value) : null,
      scenario: sv ? toStr(sv) : null,
      delta: sv && b.value ? toStr(sv.minus(b.value)) : null,
      status: sv ? 'calculated' : 'not_calculable',
      missing: sv ? [] : [...new Set(missing.length ? missing : ['Componente base no calculable'])],
    };
  });
  return { status: missingAssumptions.length ? 'incomplete' : 'complete', missingAssumptions, metrics, formulas: FORMULAS };
}
