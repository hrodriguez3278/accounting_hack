import { createHash } from 'node:crypto';
import { ASSET_CATEGORIES, IC_SELLER_CATEGORIES, LIABILITY_CATEGORIES, type AccountCategory, type RateType } from '@nexora/shared';
import { D, Decimal, toStr } from './decimal.js';
import { computeMetric, emptyBucket, METRIC_UNITS, SINGLE_RUN_METRICS, type Aggregate, type Bucket } from './metrics.js';
import {
  ENGINE_VERSION, type Account, type Company, type ConsolidationInput, type ConsolidationResult, type Entry,
  type FinancialRow, type IcMatch, type Line, type MetricResult, type MissingRate, type Rate,
} from './types.js';

// ---------------------------------------------------------------- tasas
export function rateKey(from: string, to: string, type: RateType, period: string | null, scenario: string): string {
  return `${from}>${to}|${type}|${period ?? '-'}|${scenario}`;
}

export function indexRates(rates: Rate[]): Map<string, Rate> {
  const m = new Map<string, Rate>();
  for (const r of rates) m.set(rateKey(r.fromCurrency, r.toCurrency, r.rateType, r.periodCode, r.scenario), r);
  return m;
}

export function lookupRate(idx: Map<string, Rate>, from: string, to: string, type: RateType, period: string, scenario: string): Rate | undefined {
  return idx.get(rateKey(from, to, type, type === 'historical' ? null : period, scenario));
}

export function openingPeriod(fy: number): string { return `${fy - 1}-12`; }
export function closingPeriod(fy: number): string { return `${fy}-12`; }
export function fiscalMonths(fy: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${fy}-${String(i + 1).padStart(2, '0')}`);
}

/** Recalcula qué tasas faltan para un conjunto de líneas (usado también por el motor de validación). */
export function findMissingRates(input: Pick<ConsolidationInput, 'lines' | 'accounts' | 'companies' | 'rates' | 'presentationCurrency' | 'rateScenario'>): MissingRate[] {
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const companies = new Map(input.companies.map((c) => [c.id, c]));
  const idx = indexRates(input.rates);
  const missing = new Map<string, MissingRate>();
  for (const l of input.lines) {
    const a = accounts.get(l.accountId);
    const c = companies.get(l.companyId);
    if (!a || !c || c.functionalCurrency === input.presentationCurrency) continue;
    if (lookupRate(idx, c.functionalCurrency, input.presentationCurrency, a.rateType, l.periodCode, input.rateScenario)) continue;
    const period = a.rateType === 'historical' ? null : l.periodCode;
    const k = rateKey(c.functionalCurrency, input.presentationCurrency, a.rateType, period, input.rateScenario);
    const m = missing.get(k) ?? {
      fromCurrency: c.functionalCurrency, toCurrency: input.presentationCurrency, rateType: a.rateType, periodCode: period,
      scenario: input.rateScenario, lineIds: [], companyIds: [],
    };
    m.lineIds.push(l.id);
    if (!m.companyIds.includes(c.id)) m.companyIds.push(c.id);
    missing.set(k, m);
  }
  return [...missing.values()];
}

// ---------------------------------------------------------------- intercompañía
export interface TranslatedLine extends Line { groupAmount: Decimal; account: Account; company: Company }

export function matchIntercompany(
  translated: TranslatedLine[],
  companies: Company[],
  acceptances: ConsolidationInput['acceptances'],
  params: Record<string, string>,
): IcMatch[] {
  const byCode = new Map(companies.map((c) => [c.code, c]));
  const tolAbs = D(params.ic_tolerance_abs ?? '0');
  const tolPct = D(params.ic_tolerance_pct ?? '0');
  const groups = new Map<string, TranslatedLine[]>();
  for (const t of translated) {
    if (!t.account.isIntercompany || !t.icReference) continue;
    const g = groups.get(t.icReference) ?? [];
    g.push(t);
    groups.set(t.icReference, g);
  }
  const accepted = new Map(acceptances.map((a) => [a.icReference, a]));
  const out: IcMatch[] = [];
  for (const ref of [...groups.keys()].sort()) {
    const items = groups.get(ref)!;
    const sellers = items.filter((t) => IC_SELLER_CATEGORIES.includes(t.account.category));
    const buyers = items.filter((t) => !IC_SELLER_CATEGORIES.includes(t.account.category));
    const base = {
      icReference: ref, periodCode: items[0]!.periodCode, sellerCompanyId: sellers[0]?.companyId ?? null,
      buyerCompanyId: buyers[0]?.companyId ?? null, sellerLineId: sellers[0]?.id ?? null, buyerLineId: buyers[0]?.id ?? null,
      sellerLineHash: sellers[0]?.lineHash ?? null, buyerLineHash: buyers[0]?.lineHash ?? null,
      sellerAmount: sellers[0] ? toStr(sellers[0].groupAmount) : null, buyerAmount: buyers[0] ? toStr(buyers[0].groupAmount) : null,
      difference: null, tolerance: null,
    };
    if (sellers.length !== 1 || buyers.length !== 1) {
      out.push({ ...base, status: 'unmatched',
        reason: sellers.length === 0 ? 'Falta el registro de la empresa vendedora'
          : buyers.length === 0 ? 'Falta el registro de la empresa compradora'
            : 'Más de un registro por lado para la misma referencia' });
      continue;
    }
    const s = sellers[0]!, b = buyers[0]!;
    const reciprocal = byCode.get(s.counterpartyCode ?? '')?.id === b.companyId && byCode.get(b.counterpartyCode ?? '')?.id === s.companyId;
    if (!reciprocal || s.periodCode !== b.periodCode) {
      out.push({ ...base, status: 'unmatched', reason: !reciprocal ? 'Las contrapartes declaradas no son recíprocas' : 'Los periodos no coinciden' });
      continue;
    }
    const diff = s.groupAmount.minus(b.groupAmount);
    const tol = Decimal.max(tolAbs, tolPct.times(s.groupAmount.abs()));
    const acc = accepted.get(ref);
    let status: IcMatch['status'] = 'matched';
    let reason = 'Importes recíprocos dentro de la tolerancia';
    if (diff.abs().gt(tol)) {
      if (acc && acc.sellerLineHash === s.lineHash && acc.buyerLineHash === b.lineHash) {
        status = 'accepted_difference';
        reason = 'Diferencia aceptada con aprobación registrada';
      } else {
        status = 'mismatch';
        reason = `Diferencia de ${toStr(diff.toDecimalPlaces(2))} supera la tolerancia de ${toStr(tol.toDecimalPlaces(2))}`;
      }
    }
    out.push({ ...base, difference: toStr(diff), tolerance: toStr(tol), status, reason });
  }
  return out;
}

// ---------------------------------------------------------------- consolidación
export function computeInputsHash(input: ConsolidationInput): string {
  const canonical = {
    engine: ENGINE_VERSION,
    rules: input.rulesVersion,
    version: input.versionId,
    currency: input.presentationCurrency,
    scenario: input.rateScenario,
    lines: [...input.lines].sort((a, b) => a.id.localeCompare(b.id)).map((l) => [l.id, l.lineHash, l.accountId]),
    rates: [...input.rates].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.rate]),
    adjustments: [...input.adjustments].sort((a, b) => a.id.localeCompare(b.id)).map((a) => [a.id, a.amount, a.accountId]),
    acceptances: [...input.acceptances].sort((a, b) => a.icReference.localeCompare(b.icReference)),
    parameters: Object.entries(input.parameters).sort(([a], [b]) => a.localeCompare(b)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function consolidate(input: ConsolidationInput): ConsolidationResult {
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const accountsByCode = new Map(input.accounts.map((a) => [a.code, a]));
  const companies = new Map(input.companies.map((c) => [c.id, c]));
  const idx = indexRates(input.rates);
  const pres = input.presentationCurrency;
  const entries: Entry[] = [];
  const blocking: string[] = [];
  const applied = new Map<string, Rate>();

  // 1. Traducción línea a línea
  const missingRates = findMissingRates(input);
  const translated: TranslatedLine[] = [];
  for (const l of input.lines) {
    const account = accounts.get(l.accountId);
    const company = companies.get(l.companyId);
    if (!account || !company) throw new Error(`Línea ${l.id} con cuenta o empresa desconocida`);
    if (l.currency !== company.functionalCurrency) {
      blocking.push(`Línea ${l.id}: moneda ${l.currency} distinta de la funcional ${company.functionalCurrency}`);
      continue;
    }
    let rate: Decimal;
    let rateType: Entry['rateType'];
    let rateId: string | null = null;
    if (company.functionalCurrency === pres) {
      rate = D(1);
      rateType = 'identity';
    } else {
      const r = lookupRate(idx, company.functionalCurrency, pres, account.rateType, l.periodCode, input.rateScenario);
      if (!r) continue; // reportado en missingRates
      rate = D(r.rate);
      rateType = r.rateType;
      rateId = r.id;
      applied.set(r.id, r);
    }
    const g = D(l.amount).times(rate);
    translated.push({ ...l, groupAmount: g, account, company });
    entries.push({
      companyId: l.companyId, accountId: l.accountId, periodCode: l.periodCode, entryType: 'translation', sourceLineId: l.id,
      icReference: l.icReference, adjustmentId: null, localAmount: l.amount, localCurrency: l.currency, rate: toStr(rate),
      rateType, rateId, groupAmount: toStr(g), description: `Traducción ${account.code} a ${pres}`,
    });
  }
  if (missingRates.length) {
    blocking.push(...missingRates.map((m) =>
      `Falta tasa ${m.rateType} ${m.fromCurrency}→${m.toCurrency} ${m.periodCode ?? ''} (${m.scenario})`.replace('  ', ' ')));
  }

  // 2. Intercompañía: conciliación y eliminaciones explícitas (los movimientos originales no se tocan)
  const icMatches = matchIntercompany(translated, input.companies, input.acceptances, input.parameters);
  const byId = new Map(translated.map((t) => [t.id, t]));
  for (const m of icMatches) {
    if (m.status === 'mismatch' || m.status === 'unmatched') {
      blocking.push(`Intercompañía ${m.icReference}: ${m.reason}`);
      continue;
    }
    const s = byId.get(m.sellerLineId!)!;
    const b = byId.get(m.buyerLineId!)!;
    const mk = (t: TranslatedLine, amount: Decimal, accountId: string, desc: string): Entry => ({
      companyId: t.companyId, accountId, periodCode: t.periodCode, entryType: 'elimination', sourceLineId: t.id,
      icReference: m.icReference, adjustmentId: null, localAmount: null, localCurrency: null, rate: null, rateType: null,
      rateId: null, groupAmount: toStr(amount), description: desc,
    });
    entries.push(mk(s, s.groupAmount.neg(), s.accountId, `Eliminación IC ${m.icReference} (vendedor)`));
    entries.push(mk(b, b.groupAmount.neg(), b.accountId, `Eliminación IC ${m.icReference} (comprador)`));
    const diff = b.groupAmount.minus(s.groupAmount);
    if (!diff.isZero()) {
      const diffAccount = accountsByCode.get(s.account.statement === 'PL' ? '8100' : '2990');
      if (!diffAccount) throw new Error('Catálogo sin cuentas de diferencia IC (8100/2990)');
      entries.push(mk(s, diff, diffAccount.id, `Diferencia de conciliación IC ${m.icReference}`));
    }
  }

  // 3. CTA por empresa y fecha de balance: activos − pasivos − patrimonio (histórico)
  if (input.includesBalanceSheet) {
    const ctaAccount = accountsByCode.get('3900');
    if (!ctaAccount) throw new Error('Catálogo sin cuenta CTA (3900)');
    const bsTotals = new Map<string, Map<AccountCategory, Decimal>>();
    for (const t of translated) {
      if (t.account.statement !== 'BS') continue;
      const k = `${t.companyId}|${t.periodCode}`;
      const m = bsTotals.get(k) ?? new Map<AccountCategory, Decimal>();
      m.set(t.account.category, (m.get(t.account.category) ?? D(0)).plus(t.groupAmount));
      bsTotals.set(k, m);
    }
    for (const k of [...bsTotals.keys()].sort()) {
      const [companyId, period] = k.split('|') as [string, string];
      const m = bsTotals.get(k)!;
      const get = (cs: readonly AccountCategory[]) => cs.reduce((a, c) => a.plus(m.get(c) ?? D(0)), D(0));
      const cta = get(ASSET_CATEGORIES).minus(get(LIABILITY_CATEGORIES)).minus(m.get('equity') ?? D(0));
      entries.push({
        companyId, accountId: ctaAccount.id, periodCode: period, entryType: 'cta', sourceLineId: null, icReference: null,
        adjustmentId: null, localAmount: null, localCurrency: null, rate: null, rateType: null, rateId: null,
        groupAmount: toStr(cta), description: `Ajuste por conversión ${companies.get(companyId)!.code} al ${period}`,
      });
    }
  }

  // 4. Ajustes aprobados
  for (const a of input.adjustments) {
    entries.push({
      companyId: a.companyId, accountId: a.accountId, periodCode: a.periodCode, entryType: 'adjustment', sourceLineId: null,
      icReference: null, adjustmentId: a.id, localAmount: null, localCurrency: null, rate: null, rateType: null, rateId: null,
      groupAmount: a.amount, description: a.description,
    });
  }

  const financials = aggregateFinancials(entries);
  const metrics = blocking.length ? [] : computeRunMetrics(input, financials);
  const ratesApplied = [...applied.values()].map(({ id, fromCurrency, toCurrency, periodCode, rateType, rate, scenario }) =>
    ({ id, fromCurrency, toCurrency, periodCode, rateType, rate, scenario }));

  return {
    entries, financials, icMatches, missingRates, metrics, ratesApplied,
    blockingReasons: blocking,
    inputsHash: computeInputsHash(input),
    summary: {
      lines: input.lines.length,
      translation_entries: entries.filter((e) => e.entryType === 'translation').length,
      elimination_entries: entries.filter((e) => e.entryType === 'elimination').length,
      cta_entries: entries.filter((e) => e.entryType === 'cta').length,
      adjustment_entries: entries.filter((e) => e.entryType === 'adjustment').length,
      ic_matches: icMatches.length,
      ic_accepted_differences: icMatches.filter((m) => m.status === 'accepted_difference').length,
      blocking: blocking.length,
    },
  };
}

export function aggregateFinancials(entries: Entry[]): FinancialRow[] {
  const m = new Map<string, { t: Decimal; e: Decimal; c: Decimal; a: Decimal; key: [string, string, string] }>();
  for (const e of entries) {
    const k = `${e.companyId}|${e.accountId}|${e.periodCode}`;
    const r = m.get(k) ?? { t: D(0), e: D(0), c: D(0), a: D(0), key: [e.companyId, e.accountId, e.periodCode] };
    const v = D(e.groupAmount);
    if (e.entryType === 'translation') r.t = r.t.plus(v);
    else if (e.entryType === 'elimination') r.e = r.e.plus(v);
    else if (e.entryType === 'cta') r.c = r.c.plus(v);
    else r.a = r.a.plus(v);
    m.set(k, r);
  }
  return [...m.values()].map((r) => ({
    companyId: r.key[0], accountId: r.key[1], periodCode: r.key[2],
    translated: toStr(r.t), elimination: toStr(r.e), cta: toStr(r.c), adjustment: toStr(r.a),
    total: toStr(r.t.plus(r.e).plus(r.c).plus(r.a)),
  }));
}

// ---------------------------------------------------------------- agregados para métricas
export interface AggregateOptions {
  mode: 'consolidated' | 'standalone';
  fiscalYear: number;
  companyIds?: Set<string>;
  months?: Set<string>;
  accountIds?: Set<string>;
  params: Record<string, string>;
  groupRevenue?: Decimal;
}

export function buildAggregate(financials: FinancialRow[], accounts: Account[], opt: AggregateOptions): Aggregate {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const months = opt.months ?? new Set(fiscalMonths(opt.fiscalYear));
  const open = openingPeriod(opt.fiscalYear);
  const close = closingPeriod(opt.fiscalYear);
  const pl = new Map<AccountCategory, Bucket>();
  const bo = new Map<AccountCategory, Bucket>();
  const bc = new Map<AccountCategory, Bucket>();
  const add = (map: Map<AccountCategory, Bucket>, c: AccountCategory, r: FinancialRow) => {
    const b = map.get(c) ?? emptyBucket();
    b.translated = b.translated.plus(r.translated);
    b.elimination = b.elimination.plus(r.elimination);
    b.cta = b.cta.plus(r.cta);
    b.adjustment = b.adjustment.plus(r.adjustment);
    map.set(c, b);
  };
  for (const r of financials) {
    if (opt.companyIds && !opt.companyIds.has(r.companyId)) continue;
    if (opt.accountIds && !opt.accountIds.has(r.accountId)) continue;
    const a = acc.get(r.accountId);
    if (!a) continue;
    // En modo individual una fila que solo contiene eliminaciones no cuenta como componente presente
    if (opt.mode === 'standalone' && D(r.translated).isZero() && D(r.cta).isZero() && !D(r.elimination).isZero() && a.category !== 'revenue') continue;
    if (a.statement === 'PL' && months.has(r.periodCode)) add(pl, a.category, r);
    else if (a.statement === 'BS' && r.periodCode === open) add(bo, a.category, r);
    else if (a.statement === 'BS' && r.periodCode === close) add(bc, a.category, r);
  }
  const params: Record<string, Decimal | undefined> = {};
  for (const [k, v] of Object.entries(opt.params)) params[k] = D(v);
  return {
    mode: opt.mode, pl, bsOpening: bo.size ? bo : null, bsClosing: bc.size ? bc : null,
    openingLabel: open, closingLabel: close, params, groupRevenue: opt.groupRevenue,
  };
}

export function computeRunMetrics(input: Pick<ConsolidationInput, 'accounts' | 'companies' | 'fiscalYear' | 'parameters'>, financials: FinancialRow[]): MetricResult[] {
  const out: MetricResult[] = [];
  const label = `FY${input.fiscalYear}`;
  const groupAgg = buildAggregate(financials, input.accounts, { mode: 'consolidated', fiscalYear: input.fiscalYear, params: input.parameters });
  const groupRevenue = computeMetric('revenue', groupAgg).value ?? undefined;
  groupAgg.groupRevenue = groupRevenue;
  const scopes: Array<{ scope: 'group' | 'company'; companyId: string | null; agg: Aggregate }> = [
    { scope: 'group', companyId: null, agg: groupAgg },
    ...input.companies.map((c) => ({
      scope: 'company' as const, companyId: c.id,
      agg: buildAggregate(financials, input.accounts, {
        mode: 'standalone', fiscalYear: input.fiscalYear, companyIds: new Set([c.id]), params: input.parameters, groupRevenue,
      }),
    })),
  ];
  for (const s of scopes) {
    for (const code of SINGLE_RUN_METRICS) {
      if (s.scope === 'group' && code === 'revenue_share') continue;
      const r = computeMetric(code, s.agg);
      out.push({
        metricCode: code, scope: s.scope, companyId: s.companyId, periodLabel: label,
        value: r.value ? toStr(r.value) : null, unit: METRIC_UNITS[code]!, status: r.value ? 'calculated' : 'not_calculable',
        missing: r.missing,
        components: Object.fromEntries(Object.entries(r.components).map(([k, v]) => [k, v ? toStr(v) : null])),
      });
    }
  }
  return out;
}
