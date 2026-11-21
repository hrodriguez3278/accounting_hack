import { randomUUID } from 'node:crypto';
import { DashboardPlan, WidgetSpec, type DashboardAction } from '@nexora/shared';
import { normalizeText, resolveTerms } from '@nexora/semantic-engine';
import { selectVisualization } from '@nexora/dashboard-engine';
import type { AgentContext, ChatMessage, CompletionRequest, CompletionResult, LlmProvider, ToolCall } from './types.js';

/**
 * Proveedor local determinista: interpreta instrucciones en español con reglas y el catálogo semántico,
 * y redacta respuestas exclusivamente a partir de resultados de herramientas. No requiere red ni credenciales.
 */
export class LocalRulesProvider implements LlmProvider {
  readonly name = 'local';

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user') as Extract<ChatMessage, { role: 'user' }> | undefined;
    const question = lastUser?.content ?? '';
    const userIdx = req.messages.lastIndexOf(lastUser!);
    const toolMsgs = req.messages.slice(userIdx + 1).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
    const intent = detectIntent(question, req.context);
    if (!toolMsgs.length) {
      return { content: null, toolCalls: intent.calls.map((c) => ({ id: randomUUID(), name: c.name, arguments: c.args })) };
    }
    const results = toolMsgs.map((m) => ({ name: m.name, data: safeJson(m.content) }));
    return { content: compose(intent, results, req.context), toolCalls: [] };
  }

  async planDashboard(instruction: string, ctx: AgentContext): Promise<DashboardPlan> {
    return DashboardPlan.parse(planDashboardLocal(instruction, ctx));
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------- utilidades de interpretación
const NUMBER_WORDS: Record<string, number> = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const COUNTRY_WORDS: Record<string, string> = { guatemala: 'GT', honduras: 'HN', 'el salvador': 'SV', salvador: 'SV', panama: 'PA', 'costa rica': 'CR', mexico: 'MX' };

function detectVersions(q: string, ctx: AgentContext): string[] {
  const out: Array<{ pos: number; code: string }> = [];
  const re = /(?:version|v)\s?(\d)\b/g;
  for (const m of q.matchAll(re)) {
    const v = ctx.versions.find((x) => x.code.endsWith(`V${m[1]}`));
    if (v) out.push({ pos: m.index ?? 0, code: v.code });
  }
  const fc = /(proyecci|ejecuci|real(es)?\b|forecast)/.exec(q);
  if (fc) {
    const v = ctx.versions.find((x) => x.kind === 'forecast');
    if (v) out.push({ pos: fc.index, code: v.code });
  }
  return [...new Set(out.sort((a, b) => a.pos - b.pos).map((x) => x.code))];
}

function detectCompanies(q: string, ctx: AgentContext): string[] {
  const out = new Set<string>();
  for (const c of ctx.companies) {
    const code = normalizeText(c.code);
    const short = code.split('-').pop()!;
    const nameWords = normalizeText(c.name).replace(/\(demo\)/, '').split(' ').filter((w) => w.length > 5 && !['altavista', 'guatemala', 'honduras', 'salvador', 'panama'].includes(w));
    if (q.includes(code) || new RegExp(`\\b${short}\\b`).test(q) || nameWords.some((w) => q.includes(w))) out.add(c.code);
  }
  const m = /empresa\s+([a-z])\b/.exec(q);
  if (m) {
    const idx = m[1]!.charCodeAt(0) - 97;
    const c = ctx.companies[idx];
    if (c) out.add(c.code);
  }
  return [...out];
}

function detectCountries(q: string): string[] {
  return [...new Set(Object.entries(COUNTRY_WORDS).filter(([w]) => q.includes(w)).map(([, c]) => c))];
}

function percentAfter(q: string, re: RegExp): string | undefined {
  const m = re.exec(q);
  if (!m) return undefined;
  const rest = q.slice(m.index);
  const p = /(-?\d+(?:[.,]\d+)?)\s?%/.exec(rest);
  if (!p) return undefined;
  return (Number(p[1]!.replace(',', '.')) / 100).toString();
}

function defaultCompare(ctx: AgentContext, current: string): string | undefined {
  const cur = current === 'approved' ? ctx.versions.find((v) => v.code === ctx.defaultVersion) : ctx.versions.find((v) => v.code === current);
  const others = ctx.versions.filter((v) => v.code !== cur?.code && v.kind === 'budget');
  return others.find((v) => v.published)?.code ?? others[0]?.code;
}

// ---------------------------------------------------------------- analista
type Intent = { kind: string; metric?: string; calls: Array<{ name: string; args: unknown }>; question: string };

const BRIDGEABLE = ['revenue', 'costs', 'opex', 'ebitda', 'ebit', 'net_income'];

export function detectIntent(question: string, ctx: AgentContext): Intent {
  const q = normalizeText(question);
  const terms = resolveTerms(question, ctx.catalog);
  const versions = detectVersions(q, ctx);
  const companies = detectCompanies(q, ctx);
  const countries = detectCountries(q);
  const period = ctx.period;
  const metric = terms.metrics.find((m) => m !== 'revenue_share' && m !== 'ic_elimination_impact') ?? terms.metrics[0];
  const current = versions.length >= 2 ? versions[1]! : versions[0] ?? ctx.defaultVersion;

  if (/simul|escenario|que pasaria|supon/.test(q)) {
    const assumptions: Record<string, string> = {};
    const set = (k: string, v: string | undefined, sign = 1) => { if (v !== undefined) assumptions[k] = String(Number(v) * sign); };
    set('opex_reduction', percentAfter(q, /(reduc|disminu|recort|baj)[a-z]* (de |en )?(los )?gastos/));
    set('revenue_growth', percentAfter(q, /(crec|aument|increment|sub)[a-z]* (de |en )?(los )?(ingresos|ventas)/));
    set('revenue_growth', percentAfter(q, /(caid|reduc|disminu)[a-z]* (de |en )?(los )?(ingresos|ventas)/), -1);
    set('cost_increase', percentAfter(q, /(increment|aument|sub)[a-z]* (de |en )?(los )?costos/));
    set('fx_change', percentAfter(q, /(tipo de cambio|tasa de cambio|devalua|aprecia)/));
    set('cost_of_capital', percentAfter(q, /(wacc|costo de capital)/));
    set('tax_rate', percentAfter(q, /(tasa impositiva|impuesto)/));
    set('operating_yield', percentAfter(q, /(rendimiento operativo|retorno de la inversion)/));
    const inv = /inversion adicional de (?:usd\s?)?([\d,.]+)\s?(m|millones)?/.exec(q);
    if (inv) assumptions.additional_investment = String(Number(inv[1]!.replace(/,/g, '')) * (inv[2] ? 1e6 : 1));
    return { kind: 'scenario', question, calls: [{ name: 'create_scenario', args: {
      name: `Simulación: ${question.slice(0, 80)}`, base_version: current, fiscal_year: period, assumptions } }] };
  }
  if (/de donde (proviene|sale|viene)|origen|trazabilidad|rastre|procedencia/.test(q)) {
    return { kind: 'lineage', metric: metric ?? 'revenue', question, calls: [{ name: 'get_lineage', args: {
      metric: metric ?? 'revenue', version: current, period, ...(companies[0] ? { company: companies[0] } : {}) } }] };
  }
  if (/incidencia|errores|calidad de (los )?datos|validacion/.test(q)) {
    return { kind: 'issues', question, calls: [{ name: 'get_validation_issues', args: { version: current, period } }] };
  }
  if (/intercompa|intercompany|elimin/.test(q)) {
    return { kind: 'intercompany', question, calls: [
      { name: 'query_financial_metrics', args: { metrics: ['ic_elimination_impact', 'revenue'], dimensions: [], filters: { period, version: current } } },
      { name: 'get_consolidation_details', args: { version: current, period } },
    ] };
  }
  if (/porcentaje|participacion|representa/.test(q)) {
    return { kind: 'share', question, calls: [{ name: 'query_financial_metrics', args: {
      metrics: ['revenue_share', 'revenue'], dimensions: ['company'], filters: { period, version: current,
        ...(companies.length ? { companies } : {}) }, sort: { field: 'revenue_share', direction: 'desc' } } }] };
  }
  if (/desviacion|mayor variacion|variacion presupuestaria/.test(q)) {
    const fc = ctx.versions.find((v) => v.kind === 'forecast')?.code;
    const cur = versions.length >= 2 ? versions[1]! : fc ?? current;
    const base = versions.length >= 2 ? versions[0]! : (versions[0] && versions[0] !== cur ? versions[0] : ctx.defaultVersion);
    return { kind: 'deviation', metric: metric ?? 'revenue', question, calls: [{ name: 'get_budget_variances', args: {
      metric: metric ?? 'revenue', version: cur, compare_to: base, period } }] };
  }
  if (/que cambio|cambios entre|diferencia(s)? entre|compara/.test(q) && versions.length >= 1) {
    const base = versions.length >= 2 ? versions[0]! : defaultCompare(ctx, current)!;
    const cur = versions.length >= 2 ? versions[1]! : current;
    return { kind: 'changes', question, calls: ['revenue', 'ebitda', 'net_income'].map((m) => ({ name: 'compare_budget_versions',
      args: { metric: m, version: cur, compare_to: base, period } })) };
  }
  if (/por que|causa|explica|a que se debe/.test(q)) {
    const m = metric ?? 'ebitda';
    const base = versions.length >= 2 ? versions[0]! : defaultCompare(ctx, current);
    if (!base) return { kind: 'query', question, calls: [{ name: 'query_financial_metrics', args: { metrics: [m], dimensions: [], filters: { period, version: current } } }] };
    if (BRIDGEABLE.includes(m)) {
      return { kind: 'why', metric: m, question, calls: [{ name: 'compare_budget_versions', args: { metric: m, version: current, compare_to: base, period } }] };
    }
    const components: Record<string, string[]> = { roic: ['roic', 'nopat', 'invested_capital'], roce: ['roce', 'ebit', 'capital_employed'],
      eva: ['eva', 'nopat', 'invested_capital', 'wacc'], ebitda_margin: ['ebitda_margin', 'ebitda', 'revenue'], operating_margin: ['operating_margin', 'ebit', 'revenue'] };
    return { kind: 'why_ratio', metric: m, question, calls: [
      { name: 'query_financial_metrics', args: { metrics: components[m] ?? [m], dimensions: [], filters: { period, version: current, compare_to: base } } },
      { name: 'compare_budget_versions', args: { metric: 'ebit', version: current, compare_to: base, period } },
    ] };
  }
  const metrics = terms.metrics.length ? terms.metrics.slice(0, 4) : ['revenue', 'ebitda'];
  const dims = terms.dimensions.length ? terms.dimensions.slice(0, 2) : (companies.length || countries.length ? ['company'] : []);
  return { kind: 'query', question, calls: [{ name: 'query_financial_metrics', args: {
    metrics, dimensions: dims, filters: { period, version: current, ...(versions.length >= 2 ? { compare_to: versions[0] } : {}),
      ...(companies.length ? { companies } : {}), ...(countries.length ? { countries } : {}) } } }] };
}

// ---------------------------------------------------------------- redacción a partir de resultados
const fmtMoney = (v: string | null | undefined, ccy = 'USD') => v == null ? 'no disponible'
  : `${ccy} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const fmtPct = (v: string | null | undefined) => v == null ? 'no disponible' : `${(Number(v) * 100).toFixed(2)} %`;
const fmt = (v: string | null | undefined, unit: string, ccy = 'USD') => unit === 'ratio' ? fmtPct(v) : fmtMoney(v, ccy);

interface Res { name: string; data: unknown }
type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function errorOf(r: Res): string | null {
  const d = r.data as AnyObj | null;
  return d && typeof d === 'object' && 'error' in d ? String(d.error) : null;
}

function compose(intent: Intent, results: Res[], ctx: AgentContext): string {
  const errs = results.map(errorOf).filter(Boolean);
  if (errs.length && errs.length === results.length) {
    return `No pude obtener datos verificables: ${errs.join(' · ')}. Dato no disponible: no presento cifras sin respaldo.`;
  }
  const lines: string[] = [];
  const first = results[0]!.data as AnyObj;
  switch (intent.kind) {
    case 'why':
    case 'changes': {
      for (const r of results) {
        const b = r.data as AnyObj;
        if (errorOf(r)) { lines.push(`• ${errorOf(r)}`); continue; }
        const dir = Number(b.totalVariance) >= 0 ? 'aumentó' : 'disminuyó';
        lines.push(`**${b.metric_name}** ${dir} de ${fmtMoney(b.baseTotal, b.currency)} (${b.compare_to.code}) a ${fmtMoney(b.currentTotal, b.currency)} (${b.version.code}): variación ${fmtMoney(b.totalVariance, b.currency)}${b.totalVariancePct ? ` (${fmtPct(b.totalVariancePct)})` : ''}.`);
        lines.push(`Causa verificada (puente determinista): efecto volumen en moneda local ${fmtMoney(b.volumeEffect, b.currency)}, efecto cambiario ${fmtMoney(b.fxEffect, b.currency)}, eliminaciones intercompañía ${fmtMoney(b.eliminationEffect, b.currency)}, ajustes ${fmtMoney(b.adjustmentEffect, b.currency)}, residual ${fmtMoney(b.residual, b.currency)}.`);
        const top = (b.companies as AnyObj[]).slice(0, 3)
          .map((c) => `${c.code} (volumen ${fmtMoney(c.volumeEffect, b.currency)}, tipo de cambio ${fmtMoney(c.fxEffect, b.currency)})`);
        if (top.length) lines.push(`Principales contribuyentes: ${top.join('; ')}.`);
      }
      lines.push('Hipótesis pendiente de confirmación: las causas operativas (precios, volúmenes físicos, decisiones comerciales) no están en los datos presupuestarios; requieren validación con cada empresa.');
      break;
    }
    case 'why_ratio': {
      const q = first;
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const row = (q.rows as AnyObj[])[0] as AnyObj;
      for (const meta of q.metrics as AnyObj[]) {
        const v = row.values[meta.metric_id];
        if (v.status !== 'calculated') { lines.push(`• ${meta.name}: no calculable (${v.missing.join('; ')}).`); continue; }
        const dir = v.variance_abs == null ? '' : Number(v.variance_abs) >= 0 ? 'subió' : 'bajó';
        lines.push(`• ${meta.name}: ${fmt(v.compare_value, meta.unit, q.currency)} en ${q.compare_version_code} → ${fmt(v.value, meta.unit, q.currency)} en ${q.budget_version_code}${dir ? ` (${dir})` : ''}.`);
      }
      const main = row.values[intent.metric!];
      if (main?.variance_abs != null && /disminu|baj|cay/.test(normalizeText(intent.question)) && Number(main.variance_abs) > 0) {
        lines.unshift('La premisa no se sostiene con los datos: la métrica no disminuyó, aumentó.');
      }
      const b = results[1]?.data as AnyObj | undefined;
      if (b && !errorOf(results[1]!)) {
        lines.push(`Causa verificada: el EBIT varió ${fmtMoney(b.totalVariance, b.currency)} (volumen ${fmtMoney(b.volumeEffect, b.currency)}, tipo de cambio ${fmtMoney(b.fxEffect, b.currency)}, residual ${fmtMoney(b.residual, b.currency)}).`);
      }
      lines.push('Correlación observada: la relación entre el resultado operativo y el capital explica la variación del indicador; las causas de negocio son hipótesis pendientes de confirmación.');
      break;
    }
    case 'deviation': {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const q = first;
      const meta = (q.metrics as AnyObj[])[0] as AnyObj;
      const rows = (q.rows as AnyObj[]).filter((r) => r.values[meta.metric_id].variance_abs != null)
        .sort((a, b) => Math.abs(Number(b.values[meta.metric_id].variance_abs)) - Math.abs(Number(a.values[meta.metric_id].variance_abs)));
      if (!rows.length) { lines.push('Dato no disponible: no hay variaciones calculables.'); break; }
      const top = rows[0]!;
      const v = top.values[meta.metric_id];
      lines.push(`La mayor desviación de **${meta.name}** entre ${q.compare_version_code} y ${q.budget_version_code} es de **${top.labels.company}**: ${fmt(v.variance_abs, meta.unit, q.currency)}${v.variance_pct ? ` (${fmtPct(v.variance_pct)})` : ''}, de ${fmt(v.compare_value, meta.unit, q.currency)} a ${fmt(v.value, meta.unit, q.currency)}.`);
      lines.push('Siguientes: ' + rows.slice(1, 4).map((r) => `${r.dimensions.company} ${fmt(r.values[meta.metric_id].variance_abs, meta.unit, q.currency)}`).join('; ') + '.');
      lines.push('Cifras individuales antes de eliminaciones intercompañía.');
      break;
    }
    case 'intercompany': {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const v = ((first.rows as AnyObj[])[0] as AnyObj).values;
      lines.push(`Las eliminaciones intercompañía sobre ingresos suman ${fmtMoney(v.ic_elimination_impact.value, first.currency)} en ${first.budget_version_code} (ingresos consolidados netos: ${fmtMoney(v.revenue.value, first.currency)}).`);
      const d = results[1]?.data as AnyObj | undefined;
      if (d && !errorOf(results[1]!)) {
        lines.push(`Operaciones conciliadas: ${d.ic.matched} emparejadas; diferencias aceptadas con aprobación: ${d.ic.accepted_difference}. Los movimientos originales no se modifican: las eliminaciones se registran como asientos explícitos.`);
      }
      break;
    }
    case 'share': {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      for (const r of first.rows as AnyObj[]) {
        lines.push(`• ${r.labels.company}: ${fmtPct(r.values.revenue_share.value)} de los ingresos consolidados (contribución después de eliminaciones atribuidas).`);
      }
      break;
    }
    case 'lineage': {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const l = first;
      lines.push(`**${l.metric.name}** (versión de fórmula ${l.metric.version}): ${l.metric.formula}.`);
      lines.push(`Valor: ${l.result?.value != null ? fmt(l.result.value, l.metric.unit) : 'no calculable'} — consolidación ${l.run.version_code}, estado ${l.run.status}, calculada el ${String(l.run.finished_at).slice(0, 10)}.`);
      lines.push(`Origen: ${l.files.length} archivos fuente (${(l.files as AnyObj[]).map((f) => f.company_code).join(', ')}) y ${(l.accounts as AnyObj[]).length} saldos por cuenta y empresa. Huella de entradas: ${String(l.run.inputs_hash).slice(0, 12)}….`);
      if (!l.lineage_complete) lines.push(l.lineage_note);
      break;
    }
    case 'issues': {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const issues = first.issues as AnyObj[];
      const open = issues.filter((i) => i.status === 'open');
      lines.push(`La versión tiene ${issues.length} incidencias registradas; ${open.length} abiertas.`);
      for (const i of open.slice(0, 8)) lines.push(`• [${i.severity}] ${i.rule_name}: ${i.description}`);
      break;
    }
    case 'scenario': {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const s = first;
      if (s.status === 'incomplete') lines.push(`Escenario incompleto. Faltan supuestos: ${s.missingAssumptions.join('; ')}.`);
      lines.push(`Simulación (no oficial) sobre ${s.base.version}:`);
      for (const m of (s.metrics as AnyObj[]).filter((x) => ['revenue', 'ebitda', 'ebit', 'nopat', 'roic', 'eva'].includes(x.metricCode))) {
        lines.push(`• ${m.metricCode.toUpperCase()}: base ${fmt(m.base, m.unit)} → simulado ${fmt(m.scenario, m.unit)}${m.status !== 'calculated' ? ` (no calculable: ${m.missing.join('; ')})` : ''}.`);
      }
      lines.push('Supuestos explícitos: ' + Object.entries(s.assumptions ?? {}).map(([k, v]) => `${k} = ${v}`).join(', ') + '.');
      break;
    }
    default: {
      if (errorOf(results[0]!)) { lines.push(errorOf(results[0]!)!); break; }
      const q = first;
      for (const r of (q.rows as AnyObj[]).slice(0, 12)) {
        const label = Object.values(r.labels).join(' · ') || 'Grupo consolidado';
        const parts = (q.metrics as AnyObj[]).map((m) => {
          const v = r.values[m.metric_id];
          if (v.status !== 'calculated') return `${m.name}: no calculable (${v.missing.join('; ')})`;
          return `${m.name}: ${fmt(v.value, m.unit, q.currency)}${v.compare_value != null ? ` (vs ${fmt(v.compare_value, m.unit, q.currency)})` : ''}`;
        });
        lines.push(`• ${label} — ${parts.join(' · ')}`);
      }
      lines.unshift(`${q.budget_version_code}, ejercicio ${q.period}, ${q.certification_status === 'certified' ? 'cifras certificadas' : 'cifras NO certificadas'}:`);
    }
  }
  const warnings = results.flatMap((r) => ((r.data as AnyObj)?.warnings as string[] | undefined) ?? []);
  if (warnings.length) lines.push(`Advertencias: ${[...new Set(warnings)].join(' ')}`);
  void ctx;
  return lines.join('\n');
}

// ---------------------------------------------------------------- estudio de dashboards
export function planDashboardLocal(instruction: string, ctx: AgentContext): { actions: DashboardAction[]; explanation: string } {
  const q = normalizeText(instruction);
  const terms = resolveTerms(instruction, ctx.catalog);
  const widgets = ctx.dashboard?.widgets ?? [];
  const units = Object.fromEntries([...ctx.catalog.metrics.values()].map((m) => [m.code, m.unit])) as Record<string, 'currency' | 'ratio'>;
  const name = (code: string) => ctx.catalog.metrics.get(code)?.name ?? code;
  const actions: DashboardAction[] = [];
  const last = widgets.at(-1);
  const targetByMetric = (m?: string) => (m ? [...widgets].reverse().find((w) => w.spec.metric_ids.includes(m)) : undefined) ?? last;
  const chart = terms.charts[0] as WidgetSpec['type'] | undefined;
  const countries = detectCountries(q);
  const compareDefault = defaultCompare(ctx, ctx.defaultVersion);

  if (/(crea|arma|genera|construye)[a-z]* (me )?(un |el )?(nuevo )?dashboard/.test(q)) {
    const add = (s: unknown) => actions.push({ action: 'add_widget', widget: WidgetSpec.parse(s) });
    add({ title: 'Ingresos consolidados', type: 'kpi', metric_ids: ['revenue'], size: 'sm' });
    add({ title: 'EBITDA', type: 'kpi', metric_ids: ['ebitda'], size: 'sm' });
    add({ title: 'ROIC', type: 'kpi', metric_ids: ['roic'], size: 'sm' });
    add({ title: 'EVA', type: 'kpi', metric_ids: ['eva'], size: 'sm' });
    add({ title: 'Ingresos y EBITDA por empresa', type: 'bar', metric_ids: ['revenue', 'ebitda'], dimensions: ['company'], size: 'xl',
      sort: { field: 'revenue', direction: 'desc' } });
    add({ title: 'Rentabilidad por empresa', type: 'table', metric_ids: ['ebitda_margin', 'roic', 'roce', 'eva'], dimensions: ['company'], size: 'xl' });
    return { actions, explanation: `Dashboard financiero de las ${ctx.companies.length} empresas con KPIs certificados y comparativos por empresa.` };
  }
  if (/(guarda|renombra|llama)[a-z]* (este |el )?dashboard/.test(q)) {
    const m = /como ["“']?(.+?)["”']?$/.exec(instruction.trim());
    const n = m ? m[1]!.replace(/^(mi|la|el)\s/i, (x) => x).trim() : 'Mi vista ejecutiva';
    actions.push({ action: 'rename_dashboard', name: n.charAt(0).toUpperCase() + n.slice(1) });
    return { actions, explanation: `Dashboard guardado como "${actions[0]!.action === 'rename_dashboard' ? (actions[0] as { name: string }).name : ''}".` };
  }
  if (/(elimina|quita|borra|remueve)/.test(q) && !/filtro/.test(q)) {
    const m = terms.metrics[0];
    let targets = widgets.filter((w) => m && w.spec.metric_ids.includes(m));
    if (/(indicador|kpi|tarjeta)/.test(q)) {
      const kpis = targets.filter((w) => w.spec.type === 'kpi');
      if (kpis.length) targets = kpis;
    }
    if (!m && /(esta|ultima|ultimo)/.test(q) && last) targets = [last];
    for (const t of targets) actions.push({ action: 'remove_widget', widget_id: t.id });
    return { actions, explanation: targets.length ? `Se elimina: ${targets.map((t) => t.title).join(', ')}.` : 'No encontré un widget que coincida.' };
  }
  if (/quita[a-z]* (el |los )?filtro|sin filtro|todas las empresas/.test(q)) {
    actions.push({ action: 'set_global_filters', filters: { countries: [], companies: [] } });
    return { actions, explanation: 'Filtros globales eliminados.' };
  }
  if (/filtra|solamente|solo (las )?empresas|unicamente/.test(q) && countries.length) {
    actions.push({ action: 'set_global_filters', filters: { countries } });
    return { actions, explanation: `Filtro global: empresas de ${countries.join(', ')}. Las cifras pasan a base individual antes de eliminaciones.` };
  }
  if (/ordena/.test(q)) {
    const target = targetByMetric(terms.metrics[0]);
    if (target) {
      const dir = /menor a mayor|ascendente/.test(q) ? 'asc' : 'desc';
      actions.push({ action: 'update_widget', widget_id: target.id, changes: { sort: { field: terms.metrics[0] ?? target.spec.metric_ids[0]!, direction: dir } } });
      return { actions, explanation: `"${target.title}" ordenado de ${dir === 'desc' ? 'mayor a menor' : 'menor a mayor'}.` };
    }
  }
  if (/(cambia|convierte|muestra[a-z]* como|pasa)/.test(q) && chart && !/agrega|anade|añade/.test(q)) {
    const target = targetByMetric(terms.metrics[0]);
    if (target) {
      actions.push({ action: 'update_widget', widget_id: target.id, changes: { type: chart } });
      return { actions, explanation: `"${target.title}" ahora se muestra como ${chart}.` };
    }
  }
  if (/compara.*(real|ejecuci|proyecci).*(presupuesto)|compara.*(presupuesto).*(real|ejecuci|proyecci)/.test(q)) {
    const fc = ctx.versions.find((v) => v.kind === 'forecast')?.code;
    const m = terms.metrics[0] ?? 'revenue';
    actions.push({ action: 'add_widget', widget: WidgetSpec.parse({ title: `${name(m)}: proyección vs. presupuesto`, type: 'variance', metric_ids: [m],
      dimensions: ['company'], size: 'xl', filters: { version: fc, compare_to: ctx.defaultVersion } }) });
    return { actions, explanation: `Comparación de ${name(m)} entre la proyección de ejecución y el presupuesto publicado, por empresa.` };
  }
  // Agregar widget (opción por defecto)
  const metrics = terms.metrics.length ? terms.metrics.slice(0, 3) : ['revenue'];
  const topN = /(?:top|las|los|primeras?|mayores?)\s+(\d+|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/.exec(q);
  const n = topN ? Number(topN[1]) || NUMBER_WORDS[topN[1]!] : undefined;
  let dims = terms.dimensions.slice(0, 2) as WidgetSpec['dimensions'];
  if (n && !dims.length) dims = ['company'];
  const isKpi = /\bkpi\b|indicador|tarjeta/.test(q) && !dims.length;
  const type = isKpi ? 'kpi' : chart ?? selectVisualization(metrics, dims, units);
  const filters: Record<string, unknown> = {};
  if (metrics.includes('fx_effect')) filters.compare_to = compareDefault;
  if (countries.length) filters.countries = countries;
  const sortDir = /menor/.test(q) ? 'asc' : 'desc';
  const spec = WidgetSpec.parse({
    title: `${metrics.map(name).join(' y ')}${dims.length ? ` por ${dims.map((d) => ctx.catalog.dimensions.get(d)?.name.toLowerCase() ?? d).join(' y ')}` : ''}${n ? ` (top ${n})` : ''}`.slice(0, 120),
    type, metric_ids: metrics, dimensions: dims, size: type === 'kpi' ? 'sm' : dims.includes('period') || metrics.length > 1 ? 'xl' : 'lg',
    filters, ...(n || /mayor|menor|ordena/.test(q) ? { sort: { field: metrics[0]!, direction: sortDir } } : {}), ...(n ? { limit: n } : {}),
  });
  actions.push({ action: 'add_widget', widget: spec });
  return { actions, explanation: `Se agrega "${spec.title}" (${spec.type}) con datos de la capa semántica.` };
}

export { type ToolCall };
