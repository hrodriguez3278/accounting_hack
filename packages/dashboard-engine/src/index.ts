import { randomUUID } from 'node:crypto';
import {
  DashboardAction, WidgetSpec, type SemanticFilters, type SemanticQueryRequest,
} from '@nexora/shared';

export interface WidgetState { id: string; spec: WidgetSpec; position: number }
export interface DashboardState {
  name: string;
  globalFilters: Partial<SemanticFilters>;
  widgets: WidgetState[];
}

export interface ApplyResult {
  state: DashboardState;
  summary: string[];
  destructive: boolean;
}

/** Validación de una métrica/dimensión contra el catálogo (inyectada para no acoplar el motor a la base de datos). */
export type SpecValidator = (spec: WidgetSpec) => string | null;

/**
 * Layout Manager + Widget Persistence (lógica pura): aplica acciones declarativas validadas por Zod.
 * No ejecuta código, no evalúa expresiones y no acepta componentes generados por el modelo.
 */
export function applyActions(current: DashboardState, rawActions: unknown[], validateSpec: SpecValidator): ApplyResult {
  const state: DashboardState = structuredClone(current);
  const summary: string[] = [];
  let removed = 0;
  for (const raw of rawActions) {
    const a = DashboardAction.parse(raw);
    switch (a.action) {
      case 'add_widget': {
        const err = validateSpec(a.widget);
        if (err) throw new Error(err);
        state.widgets.push({ id: randomUUID(), spec: a.widget, position: state.widgets.length });
        summary.push(`Widget agregado: ${a.widget.title}`);
        break;
      }
      case 'update_widget': {
        const w = state.widgets.find((x) => x.id === a.widget_id);
        if (!w) throw new Error('Widget inexistente');
        const merged = WidgetSpec.parse({ ...w.spec, ...stripUndefined(a.changes),
          filters: { ...w.spec.filters, ...(a.changes.filters ?? {}) }, options: { ...w.spec.options, ...(a.changes.options ?? {}) } });
        const err = validateSpec(merged);
        if (err) throw new Error(err);
        w.spec = merged;
        summary.push(`Widget actualizado: ${merged.title}`);
        break;
      }
      case 'remove_widget': {
        const idx = state.widgets.findIndex((x) => x.id === a.widget_id);
        if (idx < 0) throw new Error('Widget inexistente');
        summary.push(`Widget eliminado: ${state.widgets[idx]!.spec.title}`);
        state.widgets.splice(idx, 1);
        removed += 1;
        break;
      }
      case 'reorder_widgets': {
        const order = new Map(a.order.map((id, i) => [id, i]));
        state.widgets.sort((x, y) => (order.get(x.id) ?? 999) - (order.get(y.id) ?? 999));
        summary.push('Widgets reordenados');
        break;
      }
      case 'set_global_filters':
        state.globalFilters = { ...state.globalFilters, ...stripUndefined(a.filters) };
        summary.push('Filtros globales actualizados');
        break;
      case 'rename_dashboard':
        state.name = a.name;
        summary.push(`Dashboard renombrado a "${a.name}"`);
        break;
    }
  }
  state.widgets.forEach((w, i) => { w.position = i; });
  const destructive = removed > 1 || (current.widgets.length > 0 && removed === current.widgets.length);
  return { state, summary, destructive };
}

/** Cambios masivos o destructivos propuestos por la IA requieren confirmación explícita del usuario. */
export function requiresApproval(actions: DashboardAction[], result: ApplyResult, source: 'user' | 'ai'): string | null {
  if (source !== 'ai') return null;
  if (result.destructive) return 'La IA propone eliminar varios widgets: confirme el cambio';
  if (actions.length > 6) return 'La IA propone un cambio masivo: confirme el cambio';
  return null;
}

/** Convierte un widget a una consulta semántica (Query Planner). */
export function toSemanticRequest(spec: WidgetSpec, global: Partial<SemanticFilters>, defaults: { period: string; version: string }): SemanticQueryRequest {
  return {
    metrics: spec.metric_ids,
    dimensions: spec.dimensions,
    filters: {
      period: spec.filters.period ?? global.period ?? defaults.period,
      version: spec.filters.version ?? global.version ?? defaults.version,
      compare_to: spec.filters.compare_to ?? global.compare_to,
      companies: nonEmpty(spec.filters.companies) ?? nonEmpty(global.companies),
      countries: nonEmpty(spec.filters.countries) ?? nonEmpty(global.countries),
    },
    sort: spec.sort,
    limit: spec.limit ?? 200,
  };
}

/** Visualization Selector: elige el tipo de gráfico cuando la instrucción no lo indica. */
export function selectVisualization(metricIds: string[], dimensions: string[], units: Record<string, 'currency' | 'ratio'>): WidgetSpec['type'] {
  if (!dimensions.length) return 'kpi';
  if (dimensions.includes('period')) return metricIds.length > 1 ? 'line' : 'area';
  if (metricIds.includes('revenue_share')) return 'donut';
  if (dimensions.length === 2) return 'heatmap';
  if (metricIds.length > 1 && metricIds.every((m) => units[m] === 'currency')) return 'bar';
  return 'bar';
}

export function executiveTemplate(compareTo: string | undefined): WidgetSpec[] {
  const w = (s: unknown) => WidgetSpec.parse(s);
  return [
    w({ title: 'Ingresos consolidados', type: 'kpi', metric_ids: ['revenue'], size: 'sm', filters: compareTo ? { compare_to: compareTo } : {} }),
    w({ title: 'EBITDA', type: 'kpi', metric_ids: ['ebitda'], size: 'sm', filters: compareTo ? { compare_to: compareTo } : {} }),
    w({ title: 'ROIC', type: 'kpi', metric_ids: ['roic'], size: 'sm' }),
    w({ title: 'ROCE', type: 'kpi', metric_ids: ['roce'], size: 'sm' }),
    w({ title: 'EVA', type: 'kpi', metric_ids: ['eva'], size: 'sm', options: { highlight: 'accent' } }),
    w({ title: 'Ingresos y EBITDA mensual del grupo', type: 'line', metric_ids: ['revenue', 'ebitda'], dimensions: ['period'], size: 'xl' }),
    w({ title: 'EBITDA por empresa', type: 'bar', metric_ids: ['ebitda'], dimensions: ['company'], size: 'lg',
      sort: { field: 'ebitda', direction: 'desc' } }),
    w({ title: 'Participación en ingresos', type: 'donut', metric_ids: ['revenue_share'], dimensions: ['company'], size: 'md' }),
    w({ title: 'Rentabilidad por empresa', type: 'table', metric_ids: ['revenue', 'ebitda_margin', 'roic', 'eva'], dimensions: ['company'], size: 'xl' }),
  ];
}

const nonEmpty = <T>(a: T[] | undefined): T[] | undefined => (a && a.length ? a : undefined);

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
