import type { AccountCategory } from '@nexora/shared';
import { D, Decimal } from './decimal.js';

/**
 * Métricas gobernadas. Cada estrategia es una función pura sobre un agregado de componentes consolidados.
 * Nunca se sustituye un componente faltante por cero: se devuelve `missing`.
 */

export interface Bucket {
  translated: Decimal;
  elimination: Decimal;
  cta: Decimal;
  adjustment: Decimal;
}

export const emptyBucket = (): Bucket => ({ translated: D(0), elimination: D(0), cta: D(0), adjustment: D(0) });

export interface Aggregate {
  /** consolidated = grupo (incluye eliminaciones y ajustes); standalone = empresa o país, antes de eliminaciones. */
  mode: 'consolidated' | 'standalone';
  pl: Map<AccountCategory, Bucket>;
  bsOpening: Map<AccountCategory, Bucket> | null;
  bsClosing: Map<AccountCategory, Bucket> | null;
  openingLabel: string;
  closingLabel: string;
  params: Record<string, Decimal | undefined>;
  /** Ingresos consolidados del grupo (denominador de revenue_share). */
  groupRevenue?: Decimal;
}

export interface MetricOutcome {
  value: Decimal | null;
  missing: string[];
  components: Record<string, Decimal | null>;
}

export const METRIC_UNITS: Record<string, 'currency' | 'ratio'> = {
  revenue: 'currency', costs: 'currency', opex: 'currency', ebitda: 'currency', ebit: 'currency', net_income: 'currency',
  nopat: 'currency', invested_capital: 'currency', capital_employed: 'currency', roic: 'ratio', roce: 'ratio', wacc: 'ratio',
  eva: 'currency', ebitda_margin: 'ratio', operating_margin: 'ratio', revenue_share: 'ratio', ic_elimination_impact: 'currency',
};

/** Métricas calculables sobre una sola consolidación (fx_effect requiere dos versiones: ver variance.ts). */
export const SINGLE_RUN_METRICS = Object.keys(METRIC_UNITS);

const CATEGORY_LABEL: Partial<Record<AccountCategory, string>> = {
  revenue: 'ingresos', cash: 'efectivo', equity: 'patrimonio', debt: 'deuda financiera',
};

function bucketValue(agg: Aggregate, b: Bucket | undefined): Decimal {
  if (!b) return D(0);
  return agg.mode === 'consolidated'
    ? b.translated.plus(b.elimination).plus(b.cta).plus(b.adjustment)
    : b.translated.plus(b.cta);
}

function pl(agg: Aggregate, c: AccountCategory): Decimal {
  return bucketValue(agg, agg.pl.get(c));
}

function hasPl(agg: Aggregate, c: AccountCategory): boolean {
  return agg.pl.has(c);
}

function bs(agg: Aggregate, side: 'opening' | 'closing', cats: AccountCategory[]): Decimal {
  const m = side === 'opening' ? agg.bsOpening : agg.bsClosing;
  return cats.reduce((acc, c) => acc.plus(bucketValue(agg, m?.get(c))), D(0));
}

function missingBalance(agg: Aggregate, required: AccountCategory[]): string[] {
  const out: string[] = [];
  for (const [side, map, label] of [
    ['opening', agg.bsOpening, agg.openingLabel],
    ['closing', agg.bsClosing, agg.closingLabel],
  ] as const) {
    if (!map) {
      out.push(`Balance general de ${side === 'opening' ? 'apertura' : 'cierre'} (${label}) no incluido en los datos`);
      continue;
    }
    for (const c of required) {
      if (!map.has(c)) out.push(`Saldo de ${CATEGORY_LABEL[c] ?? c} al ${label}`);
    }
  }
  return out;
}

function param(agg: Aggregate, code: string, missing: string[]): Decimal | null {
  const v = agg.params[code];
  if (v === undefined) {
    missing.push(`Parámetro aprobado '${code}'`);
    return null;
  }
  return v;
}

type Strategy = (agg: Aggregate) => MetricOutcome;

const ok = (value: Decimal | null, components: Record<string, Decimal | null> = {}, missing: string[] = []): MetricOutcome =>
  ({ value: missing.length ? null : value, missing, components });

function requireRevenue(agg: Aggregate): string[] {
  return hasPl(agg, 'revenue') ? [] : ['Registros de ingresos en el periodo'];
}

const strategies: Record<string, Strategy> = {
  revenue: (a) => ok(pl(a, 'revenue'), {}, requireRevenue(a)),
  costs: (a) => ok(pl(a, 'cogs'), {}, requireRevenue(a)),
  opex: (a) => ok(pl(a, 'opex'), {}, requireRevenue(a)),
  ebitda: (a) => {
    const r = pl(a, 'revenue'), c = pl(a, 'cogs'), o = pl(a, 'opex');
    return ok(r.minus(c).minus(o), { revenue: r, costs: c, opex: o }, requireRevenue(a));
  },
  ebit: (a) => {
    const e = strategies.ebitda!(a);
    const da = pl(a, 'da');
    return ok(e.value?.minus(da) ?? null, { ebitda: e.value, depreciation_amortization: da }, e.missing);
  },
  net_income: (a) => {
    const e = strategies.ebit!(a);
    const i = pl(a, 'interest'), o = pl(a, 'other'), t = pl(a, 'tax');
    return ok(e.value?.minus(i).minus(o).minus(t) ?? null,
      { ebit: e.value, interest: i, ic_differences: o, income_tax: t }, e.missing);
  },
  nopat: (a) => {
    const e = strategies.ebit!(a);
    const missing = [...e.missing];
    const t = param(a, 'nopat_tax_rate', missing);
    return ok(e.value && t ? e.value.times(D(1).minus(t)) : null, { ebit: e.value, nopat_tax_rate: t }, missing);
  },
  invested_capital: (a) => {
    const missing = missingBalance(a, ['cash', 'equity']);
    if (missing.length) return ok(null, {}, missing);
    const ic = (s: 'opening' | 'closing') => bs(a, s, ['debt', 'equity', 'cta']).minus(bs(a, s, ['cash']));
    const o = ic('opening'), c = ic('closing');
    return ok(o.plus(c).div(2), { opening: o, closing: c });
  },
  capital_employed: (a) => {
    const missing = missingBalance(a, ['cash', 'equity']);
    if (missing.length) return ok(null, {}, missing);
    const ce = (s: 'opening' | 'closing') =>
      bs(a, s, ['cash', 'receivables', 'inventory', 'ppe']).minus(bs(a, s, ['payables']));
    const o = ce('opening'), c = ce('closing');
    return ok(o.plus(c).div(2), { opening: o, closing: c });
  },
  roic: (a) => {
    const n = strategies.nopat!(a), ic = strategies.invested_capital!(a);
    const missing = [...n.missing, ...ic.missing];
    if (!missing.length && ic.value!.isZero()) missing.push('Capital invertido promedio distinto de cero');
    return ok(missing.length ? null : n.value!.div(ic.value!), { nopat: n.value, invested_capital: ic.value }, missing);
  },
  roce: (a) => {
    const e = strategies.ebit!(a), ce = strategies.capital_employed!(a);
    const missing = [...e.missing, ...ce.missing];
    if (!missing.length && ce.value!.isZero()) missing.push('Capital empleado promedio distinto de cero');
    return ok(missing.length ? null : e.value!.div(ce.value!), { ebit: e.value, capital_employed: ce.value }, missing);
  },
  wacc: (a) => {
    const missing = missingBalance(a, ['cash', 'equity']);
    const ke = param(a, 'cost_of_equity', missing);
    const kd = param(a, 'cost_of_debt', missing);
    const t = param(a, 'nopat_tax_rate', missing);
    if (missing.length) return ok(null, {}, missing);
    const e = bs(a, 'closing', ['equity', 'cta']);
    const d = bs(a, 'closing', ['debt']);
    const total = d.plus(e);
    if (total.lte(0)) return ok(null, {}, ['Estructura de capital positiva (deuda + patrimonio > 0)']);
    const w = e.div(total).times(ke!).plus(d.div(total).times(kd!).times(D(1).minus(t!)));
    return ok(w, { equity: e, debt: d, cost_of_equity: ke, cost_of_debt: kd, tax_rate: t });
  },
  eva: (a) => {
    const n = strategies.nopat!(a), ic = strategies.invested_capital!(a), w = strategies.wacc!(a);
    const missing = [...new Set([...n.missing, ...ic.missing, ...w.missing])];
    return ok(missing.length ? null : n.value!.minus(ic.value!.times(w.value!)),
      { nopat: n.value, invested_capital: ic.value, wacc: w.value }, missing);
  },
  ebitda_margin: (a) => {
    const e = strategies.ebitda!(a), r = pl(a, 'revenue');
    const missing = [...e.missing];
    if (!missing.length && r.isZero()) missing.push('Ingresos distintos de cero');
    return ok(missing.length ? null : e.value!.div(r), { ebitda: e.value, revenue: r }, missing);
  },
  operating_margin: (a) => {
    const e = strategies.ebit!(a), r = pl(a, 'revenue');
    const missing = [...e.missing];
    if (!missing.length && r.isZero()) missing.push('Ingresos distintos de cero');
    return ok(missing.length ? null : e.value!.div(r), { ebit: e.value, revenue: r }, missing);
  },
  revenue_share: (a) => {
    const missing = requireRevenue(a);
    const b = a.pl.get('revenue');
    const contribution = b ? b.translated.plus(b.elimination) : D(0);
    if (!a.groupRevenue || a.groupRevenue.isZero()) missing.push('Ingresos consolidados del grupo');
    return ok(missing.length ? null : contribution.div(a.groupRevenue!), { contribution, group_revenue: a.groupRevenue ?? null }, missing);
  },
  ic_elimination_impact: (a) => {
    const b = a.pl.get('revenue');
    return ok(b ? b.elimination : D(0), {});
  },
};

export function computeMetric(code: string, agg: Aggregate): MetricOutcome {
  const s = strategies[code];
  if (!s) throw new Error(`Métrica sin estrategia registrada: ${code}`);
  return s(agg);
}

export function hasStrategy(code: string): boolean {
  return code in strategies;
}
