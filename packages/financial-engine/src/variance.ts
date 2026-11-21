import type { AccountCategory, RateType } from '@nexora/shared';
import { D, Decimal, toStr } from './decimal.js';
import type { EntryType } from './types.js';

/**
 * Puente de reconciliación determinista entre dos consolidaciones (A = base, B = comparada).
 *   variación total = Σ_empresas (efecto volumen + efecto tipo de cambio) + efecto eliminaciones + efecto ajustes + residual
 * con efecto volumen_c = Σ_B local·tasa_A − Σ_A grupo  y  efecto cambiario_c = Σ_B local·(tasa_B − tasa_A).
 * La suma cuadra exactamente; cualquier diferencia se expone como `residual`.
 */
export interface BridgeEntry {
  companyId: string;
  accountId: string;
  accountCode: string;
  category: AccountCategory;
  periodCode: string;
  entryType: EntryType;
  localAmount: string | null;
  localCurrency: string | null;
  rateType: RateType | 'identity' | null;
  groupAmount: string;
}

export type RateLookup = (currency: string, rateType: RateType, periodCode: string) => Decimal | undefined;

export interface BridgeInput {
  base: BridgeEntry[];
  current: BridgeEntry[];
  baseRates: RateLookup;
  /** Signo con que cada categoría contribuye a la métrica (revenue: +1, cogs: −1 …). */
  signs: Partial<Record<AccountCategory, 1 | -1>>;
  months: Set<string>;
}

export interface CompanyBridge {
  companyId: string;
  base: string;
  current: string;
  volumeEffect: string;
  fxEffect: string;
}

export interface BridgeResult {
  baseTotal: string;
  currentTotal: string;
  totalVariance: string;
  totalVariancePct: string | null;
  companies: CompanyBridge[];
  accounts: Array<{ accountCode: string; base: string; current: string; variance: string }>;
  eliminationEffect: string;
  adjustmentEffect: string;
  fxEffect: string;
  volumeEffect: string;
  residual: string;
  warnings: string[];
}

export const METRIC_SIGNS: Record<string, Partial<Record<AccountCategory, 1 | -1>>> = {
  revenue: { revenue: 1 },
  costs: { cogs: 1 },
  opex: { opex: 1 },
  ebitda: { revenue: 1, cogs: -1, opex: -1 },
  ebit: { revenue: 1, cogs: -1, opex: -1, da: -1 },
  net_income: { revenue: 1, cogs: -1, opex: -1, da: -1, interest: -1, other: -1, tax: -1 },
};

export function varianceBridge(input: BridgeInput): BridgeResult {
  const warnings: string[] = [];
  const signed = (e: BridgeEntry, v: Decimal) => v.times(input.signs[e.category] ?? 0);
  const inScope = (e: BridgeEntry) => input.signs[e.category] !== undefined && input.months.has(e.periodCode);
  const base = input.base.filter(inScope);
  const cur = input.current.filter(inScope);

  const companies = new Map<string, { base: Decimal; current: Decimal; volume: Decimal; fx: Decimal }>();
  const comp = (id: string) => {
    const c = companies.get(id) ?? { base: D(0), current: D(0), volume: D(0), fx: D(0) };
    companies.set(id, c);
    return c;
  };
  const accounts = new Map<string, { base: Decimal; current: Decimal }>();
  const acct = (code: string) => {
    const a = accounts.get(code) ?? { base: D(0), current: D(0) };
    accounts.set(code, a);
    return a;
  };

  let elimA = D(0), elimB = D(0), adjA = D(0), adjB = D(0), residual = D(0);
  for (const e of base) {
    const v = signed(e, D(e.groupAmount));
    acct(e.accountCode).base = acct(e.accountCode).base.plus(v);
    if (e.entryType === 'translation') {
      const c = comp(e.companyId);
      c.base = c.base.plus(v);
      c.volume = c.volume.minus(v);
    } else if (e.entryType === 'elimination') elimA = elimA.plus(v);
    else if (e.entryType === 'adjustment') adjA = adjA.plus(v);
  }
  let unexplainedFx = 0;
  for (const e of cur) {
    const v = signed(e, D(e.groupAmount));
    acct(e.accountCode).current = acct(e.accountCode).current.plus(v);
    if (e.entryType === 'translation') {
      const c = comp(e.companyId);
      c.current = c.current.plus(v);
      let atBaseRate: Decimal | undefined;
      if (e.rateType === 'identity') atBaseRate = D(e.groupAmount);
      else if (e.localAmount !== null && e.localCurrency && e.rateType) {
        const r = input.baseRates(e.localCurrency, e.rateType, e.periodCode);
        if (r) atBaseRate = D(e.localAmount).times(r);
      }
      if (atBaseRate === undefined) {
        unexplainedFx += 1;
        residual = residual.plus(v);
        c.volume = c.volume.plus(0);
        continue;
      }
      const vb = signed(e, atBaseRate);
      c.volume = c.volume.plus(vb);
      c.fx = c.fx.plus(v.minus(vb));
    } else if (e.entryType === 'elimination') elimB = elimB.plus(v);
    else if (e.entryType === 'adjustment') adjB = adjB.plus(v);
  }
  if (unexplainedFx) warnings.push(`${unexplainedFx} asientos sin tasa comparable en la versión base: su efecto se muestra como residual`);

  const baseTotal = [...accounts.values()].reduce((a, x) => a.plus(x.base), D(0));
  const currentTotal = [...accounts.values()].reduce((a, x) => a.plus(x.current), D(0));
  const total = currentTotal.minus(baseTotal);
  const vol = [...companies.values()].reduce((a, c) => a.plus(c.volume), D(0));
  const fx = [...companies.values()].reduce((a, c) => a.plus(c.fx), D(0));
  const elimEffect = elimB.minus(elimA);
  const adjEffect = adjB.minus(adjA);
  // Residual = lo que no explican los componentes (debe ser 0 salvo tasas no comparables)
  const computedResidual = total.minus(vol).minus(fx).minus(elimEffect).minus(adjEffect);
  if (!computedResidual.minus(residual).abs().lte('0.000001')) {
    warnings.push('El residual calculado difiere del residual por tasas no comparables');
  }
  return {
    baseTotal: toStr(baseTotal),
    currentTotal: toStr(currentTotal),
    totalVariance: toStr(total),
    totalVariancePct: baseTotal.isZero() ? null : toStr(total.div(baseTotal.abs())),
    companies: [...companies.entries()].map(([companyId, c]) => ({
      companyId, base: toStr(c.base), current: toStr(c.current), volumeEffect: toStr(c.volume), fxEffect: toStr(c.fx),
    })),
    accounts: [...accounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([accountCode, a]) => ({
      accountCode, base: toStr(a.base), current: toStr(a.current), variance: toStr(a.current.minus(a.base)),
    })),
    eliminationEffect: toStr(elimEffect),
    adjustmentEffect: toStr(adjEffect),
    fxEffect: toStr(fx),
    volumeEffect: toStr(vol),
    residual: toStr(computedResidual),
    warnings,
  };
}
