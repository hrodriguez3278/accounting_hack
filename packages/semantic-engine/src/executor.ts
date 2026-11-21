import { SemanticQueryRequest, type SemanticQueryResponse, type SemanticRow, type MetricValue } from '@nexora/shared';
import {
  buildAggregate, computeMetric, D, Decimal, fiscalMonths, METRIC_SIGNS, toStr, varianceBridge,
  type Account, type Company, type FinancialRow, type RateLookup,
} from '@nexora/financial-engine';
import { SemanticError, type Catalog, type FinancialQueryAdapter, type QueryContext, type RunInfo, type VersionInfo } from './types.js';

const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const COUNTRY_NAMES: Record<string, string> = { GT: 'Guatemala', HN: 'Honduras', SV: 'El Salvador', PA: 'Panamá', CR: 'Costa Rica', MX: 'México' };
const MAX_DURATION_MS = 10_000;

interface Slice {
  key: string;
  dimensions: Record<string, string>;
  labels: Record<string, string>;
  mode: 'consolidated' | 'standalone';
  companyIds?: Set<string>;
  months?: Set<string>;
  accountIds?: Set<string>;
}

interface Loaded {
  version: VersionInfo;
  run: RunInfo;
  financials: FinancialRow[];
}

/** Valida el catálogo y la compatibilidad métrica–dimensión. Lanza SemanticError si no es válida. */
export function validateAgainstCatalog(req: SemanticQueryRequest, catalog: Catalog): void {
  for (const m of req.metrics) {
    const meta = catalog.metrics.get(m);
    if (!meta) throw new SemanticError('UNKNOWN_METRIC', `La métrica '${m}' no existe en el catálogo`);
    if (meta.version === null) throw new SemanticError('METRIC_NOT_APPROVED', `La métrica '${m}' no tiene una definición aprobada`);
    for (const d of req.dimensions) {
      if (!meta.dimensions.includes(d)) {
        throw new SemanticError('INCOMPATIBLE_DIMENSION', `La métrica '${meta.name}' no admite la dimensión '${d}'`);
      }
    }
  }
  if (req.metrics.includes('fx_effect') && !req.filters.compare_to) {
    throw new SemanticError('COMPARE_REQUIRED', 'El efecto cambiario requiere una versión de comparación (compare_to)');
  }
  if (req.metrics.includes('revenue_share') && !req.dimensions.some((d) => d === 'company' || d === 'country')) {
    throw new SemanticError('INCOMPATIBLE_DIMENSION', 'La participación en ingresos requiere la dimensión empresa o país');
  }
  if (req.dimensions.length === 2 && new Set(req.dimensions).size !== 2) {
    throw new SemanticError('INVALID_DIMENSIONS', 'Dimensiones repetidas');
  }
}

export async function executeSemanticQuery(
  rawRequest: unknown,
  ctx: QueryContext,
  adapter: FinancialQueryAdapter,
): Promise<SemanticQueryResponse> {
  const started = Date.now();
  const parsed = SemanticQueryRequest.safeParse(rawRequest);
  if (!parsed.success) {
    await adapter.logQuery({ organizationId: ctx.organizationId, userId: ctx.userId, source: ctx.source, request: rawRequest,
      runIds: [], rowCount: null, durationMs: Date.now() - started, status: 'rejected', error: 'Solicitud inválida' });
    throw new SemanticError('INVALID_REQUEST', `Solicitud inválida: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const req = parsed.data;
  try {
    const result = await run(req, ctx, adapter, started);
    return result;
  } catch (e) {
    const err = e instanceof SemanticError ? e : new SemanticError('EXECUTION_ERROR', 'Error al ejecutar la consulta', 500);
    await adapter.logQuery({ organizationId: ctx.organizationId, userId: ctx.userId, source: ctx.source, request: req,
      runIds: [], rowCount: null, durationMs: Date.now() - started, status: err.status >= 500 ? 'error' : 'rejected', error: err.message });
    if (!(e instanceof SemanticError)) throw e;
    throw err;
  }
}

async function loadVersion(adapter: FinancialQueryAdapter, ctx: QueryContext, code: string, fy: number): Promise<Loaded> {
  const version = await adapter.resolveVersion(ctx.organizationId, code, fy);
  if (!version) throw new SemanticError('UNKNOWN_VERSION', `No existe la versión '${code}' para el ejercicio ${fy}`, 404);
  const run = await adapter.resolveRun(ctx.organizationId, version.id);
  if (!run) throw new SemanticError('NO_CONSOLIDATION', `La versión ${version.code} no tiene una consolidación disponible`, 404);
  const financials = await adapter.loadFinancials(run.id);
  return { version, run, financials };
}

async function run(req: SemanticQueryRequest, ctx: QueryContext, adapter: FinancialQueryAdapter, started: number): Promise<SemanticQueryResponse> {
  const catalog = await adapter.loadCatalog();
  validateAgainstCatalog(req, catalog);
  const fy = Number(req.filters.period);
  const warnings: string[] = [];

  // Autorización por empresa (independiente de la IA y del frontend)
  const [companiesAll, accounts, params] = await Promise.all([
    adapter.loadCompanies(ctx.organizationId), adapter.loadAccounts(ctx.organizationId), adapter.loadParameters(ctx.organizationId, fy),
  ]);
  const companies = companiesAll.filter((c) => ctx.accessibleCompanyIds.has(c.id));
  if (req.filters.companies) {
    const denied = req.filters.companies.filter((code) => !companies.some((c) => c.code === code));
    if (denied.length) throw new SemanticError('FORBIDDEN_COMPANY', `Sin acceso o inexistente: ${denied.join(', ')}`, 403);
  }
  const groupLevel = !req.dimensions.some((d) => d === 'company' || d === 'country') && !req.filters.companies && !req.filters.countries;
  if (groupLevel && !ctx.hasAllCompanies) {
    throw new SemanticError('FORBIDDEN_GROUP', 'Su acceso está limitado a empresas específicas: consulte con la dimensión empresa', 403);
  }

  const main = await loadVersion(adapter, ctx, req.filters.version, fy);
  const compare = req.filters.compare_to ? await loadVersion(adapter, ctx, req.filters.compare_to, fy) : null;
  if (Date.now() - started > MAX_DURATION_MS) throw new SemanticError('TIMEOUT', 'La consulta excedió el tiempo máximo', 504);

  const scoped = filterCompanies(companies, req.filters.companies, req.filters.countries);
  const slices = buildSlices(req, scoped, accounts, fy, groupLevel);
  if (!groupLevel) warnings.push('Cifras por empresa o país: base individual traducida, antes de eliminaciones intercompañía.');
  if (req.filters.companies || req.filters.countries) warnings.push('Filtro de empresas aplicado: los totales no corresponden al consolidado del grupo.');

  const certified = (run: RunInfo) => run.status === 'published';
  if (!certified(main.run)) warnings.push(`La versión ${main.version.code} no tiene una consolidación publicada: cifras no certificadas (${main.run.status}).`);
  if (main.version.kind !== 'budget') warnings.push(`La versión ${main.version.code} es una proyección, no un presupuesto oficial.`);
  if (compare && !certified(compare.run)) warnings.push(`La versión de comparación ${compare.version.code} no está publicada.`);

  const groupRevenue = (fin: FinancialRow[]) =>
    computeMetric('revenue', buildAggregate(fin, accounts, { mode: 'consolidated', fiscalYear: fy, params })).value ?? undefined;
  const mainGroupRevenue = groupRevenue(main.financials);
  const cmpGroupRevenue = compare ? groupRevenue(compare.financials) : undefined;

  // Efecto cambiario: puente de variación sobre ingresos
  let fxBySlice: Map<string, Decimal> | null = null;
  if (req.metrics.includes('fx_effect') && compare) {
    fxBySlice = await computeFxEffects(adapter, main.run, compare.run, slices, fy, accounts, scoped);
  }

  const rows: SemanticRow[] = slices.map((s) => {
    const values: Record<string, MetricValue> = {};
    const aggMain = buildAggregate(main.financials, accounts, { mode: s.mode, fiscalYear: fy, companyIds: s.companyIds, months: s.months,
      accountIds: s.accountIds, params, groupRevenue: mainGroupRevenue });
    const aggCmp = compare ? buildAggregate(compare.financials, accounts, { mode: s.mode, fiscalYear: fy, companyIds: s.companyIds,
      months: s.months, accountIds: s.accountIds, params, groupRevenue: cmpGroupRevenue }) : null;
    for (const m of req.metrics) {
      if (m === 'fx_effect') {
        const v = fxBySlice?.get(s.key);
        values[m] = v === undefined
          ? { value: null, status: 'not_calculable', missing: ['Tasas comparables entre versiones'] }
          : { value: toStr(v), status: 'calculated', missing: [] };
        continue;
      }
      const r = computeMetric(m, aggMain);
      const mv: MetricValue = { value: r.value ? toStr(r.value) : null, status: r.value ? 'calculated' : 'not_calculable', missing: r.missing };
      if (aggCmp) {
        const c = computeMetric(m, aggCmp);
        mv.compare_value = c.value ? toStr(c.value) : null;
        mv.variance_abs = r.value && c.value ? toStr(r.value.minus(c.value)) : null;
        mv.variance_pct = r.value && c.value && !c.value.isZero() ? toStr(r.value.minus(c.value).div(c.value.abs())) : null;
      }
      values[m] = mv;
    }
    return { key: s.key, dimensions: s.dimensions, labels: s.labels, values };
  });

  sortRows(rows, req.sort, req.metrics[0]!);
  const limited = rows.slice(0, req.limit);
  if (rows.length > limited.length) warnings.push(`Resultado truncado a ${req.limit} filas.`);

  const queryId = await adapter.logQuery({
    organizationId: ctx.organizationId, userId: ctx.userId, source: ctx.source, request: req,
    runIds: [main.run.id, ...(compare ? [compare.run.id] : [])], rowCount: limited.length, durationMs: Date.now() - started, status: 'ok',
  });

  const allCertified = certified(main.run) && (!compare || certified(compare.run));
  return {
    query_id: queryId,
    period: req.filters.period,
    budget_version_id: main.version.id,
    budget_version_code: main.version.code,
    budget_version_kind: main.version.kind,
    compare_version_code: compare?.version.code ?? null,
    run_id: main.run.id,
    run_status: main.run.status,
    currency: main.run.presentationCurrency,
    data_nature: main.version.kind === 'budget' ? 'official' : 'projection',
    metrics: req.metrics.map((code) => {
      const m = catalog.metrics.get(code)!;
      return { metric_id: code, metric_version: m.version!, name: m.name, formula: m.formula ?? '', unit: m.unit,
        certification_status: allCertified ? 'certified' as const : 'not_certified' as const };
    }),
    dimensions: req.dimensions,
    rows: limited,
    certification_status: allCertified ? 'certified' : 'not_certified',
    lineage_reference: `query:${queryId}/run:${main.run.id}`,
    warnings,
    computed_at: new Date().toISOString(),
  };
}

function filterCompanies(companies: Company[], codes?: string[], countries?: string[]): Company[] {
  return companies.filter((c) => (!codes || codes.includes(c.code)) && (!countries || countries.includes(c.countryCode)));
}

function buildSlices(req: SemanticQueryRequest, companies: Company[], accounts: Account[], fy: number, groupLevel: boolean): Slice[] {
  const months = req.filters.months ? new Set(req.filters.months) : undefined;
  const base: Slice = groupLevel
    ? { key: 'group', dimensions: {}, labels: {}, mode: 'consolidated', months }
    : { key: 'scope', dimensions: {}, labels: {}, mode: 'standalone', companyIds: new Set(companies.map((c) => c.id)), months };
  let slices: Slice[] = [base];
  for (const d of req.dimensions) {
    const next: Slice[] = [];
    for (const s of slices) {
      if (d === 'company') {
        for (const c of companies.filter((x) => !s.companyIds || s.companyIds.has(x.id))) {
          next.push({ ...s, key: `${s.key}|${c.code}`, mode: 'standalone', companyIds: new Set([c.id]),
            dimensions: { ...s.dimensions, company: c.code }, labels: { ...s.labels, company: c.name } });
        }
      } else if (d === 'country') {
        const countries = [...new Set(companies.map((c) => c.countryCode))].sort();
        for (const ct of countries) {
          const ids = companies.filter((c) => c.countryCode === ct && (!s.companyIds || s.companyIds.has(c.id))).map((c) => c.id);
          if (!ids.length) continue;
          next.push({ ...s, key: `${s.key}|${ct}`, mode: 'standalone', companyIds: new Set(ids),
            dimensions: { ...s.dimensions, country: ct }, labels: { ...s.labels, country: COUNTRY_NAMES[ct] ?? ct } });
        }
      } else if (d === 'period') {
        for (const m of fiscalMonths(fy).filter((x) => !months || months.has(x))) {
          next.push({ ...s, key: `${s.key}|${m}`, months: new Set([m]), dimensions: { ...s.dimensions, period: m },
            labels: { ...s.labels, period: `${MONTH_LABELS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` } });
        }
      } else if (d === 'account') {
        const cats = new Set(req.metrics.flatMap((m) => Object.keys(METRIC_SIGNS[m] ?? {})));
        for (const a of accounts.filter((x) => x.statement === 'PL' && cats.has(x.category)).sort((x, y) => x.code.localeCompare(y.code))) {
          next.push({ ...s, key: `${s.key}|${a.code}`, accountIds: new Set([a.id]), dimensions: { ...s.dimensions, account: a.code },
            labels: { ...s.labels, account: `${a.code} · ${a.name}` } });
        }
      }
    }
    slices = next;
  }
  return slices;
}

async function computeFxEffects(adapter: FinancialQueryAdapter, mainRun: RunInfo, cmpRun: RunInfo, slices: Slice[], fy: number,
  accounts: Account[], companies: Company[]): Promise<Map<string, Decimal>> {
  const [cur, base, rates] = await Promise.all([
    adapter.loadBridgeEntries(mainRun.id), adapter.loadBridgeEntries(cmpRun.id), adapter.loadRatesApplied(cmpRun.id),
  ]);
  const rateIdx = new Map(rates.map((r) => [`${r.fromCurrency}|${r.rateType}|${r.rateType === 'historical' ? '-' : r.periodCode}`, D(r.rate)]));
  const lookup: RateLookup = (ccy, type, period) => rateIdx.get(`${ccy}|${type}|${type === 'historical' ? '-' : period}`);
  const out = new Map<string, Decimal>();
  void accounts; void companies;
  for (const s of slices) {
    const inSlice = (e: { companyId: string; accountId: string }) =>
      (!s.companyIds || s.companyIds.has(e.companyId)) && (!s.accountIds || s.accountIds.has(e.accountId));
    const r = varianceBridge({
      base: base.filter(inSlice), current: cur.filter(inSlice), baseRates: lookup,
      signs: METRIC_SIGNS.revenue!, months: s.months ?? new Set(fiscalMonths(fy)),
    });
    out.set(s.key, D(r.fxEffect));
  }
  return out;
}

function sortRows(rows: SemanticRow[], sort: SemanticQueryRequest['sort'], defaultMetric: string): void {
  if (!sort) return;
  const field = sort.field;
  const dir = sort.direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = a.values[field]?.value ?? a.values[defaultMetric]?.value;
    const vb = b.values[field]?.value ?? b.values[defaultMetric]?.value;
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return D(va).comparedTo(D(vb)) * dir;
  });
}
