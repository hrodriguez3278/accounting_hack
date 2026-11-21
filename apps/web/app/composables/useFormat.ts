const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtMoney(v: string | number | null | undefined, ccy = 'USD', compact = false): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Math.abs(Number(v)) < 0.5 ? 0 : Number(v);
  if (compact && Math.abs(n) >= 1e6) return `${ccy} ${nf2.format(n / 1e6)} M`;
  if (compact && Math.abs(n) >= 1e3) return `${ccy} ${nf2.format(n / 1e3)} K`;
  return `${ccy} ${nf0.format(n)}`;
}
export function fmtPct(v: string | number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${(Number(v) * 100).toFixed(digits)} %`;
}
export function fmtValue(v: string | null | undefined, unit: string, ccy = 'USD', compact = false): string {
  return unit === 'ratio' ? fmtPct(v) : fmtMoney(v, ccy, compact);
}
export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
}
export function fmtNum(v: string | number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  const out = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
  return /^-0(\.0*)?$/.test(out) ? out.slice(1) : out;
}
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador', validating: 'Validando', blocked: 'Bloqueada', ready_for_review: 'Lista para revisión', approved: 'Aprobada',
  published: 'Publicada', failed: 'Fallida', superseded: 'Reemplazada', processed: 'Procesado', processing: 'Procesando', uploaded: 'Cargado',
  open: 'Abierta', resolved: 'Resuelta', accepted: 'Aceptada', excluded: 'Excluida', matched: 'Conciliada', mismatch: 'Descuadre',
  unmatched: 'Sin contrapartida', accepted_difference: 'Diferencia aceptada', critical: 'Crítica', warning: 'Advertencia',
  informational: 'Informativa', complete: 'Completo', incomplete: 'Incompleto', calculated: 'Calculada', not_calculable: 'No calculable',
  valid: 'Válido', invalid: 'Inválido',
};
export const KIND_LABEL: Record<string, string> = { budget: 'Presupuesto', forecast: 'Proyección', actual: 'Real' };
