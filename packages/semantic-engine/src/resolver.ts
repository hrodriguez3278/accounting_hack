import type { Catalog } from './types.js';

export const normalizeText = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

export interface ResolvedTerms {
  metrics: string[];
  dimensions: string[];
  charts: string[];
}

/**
 * Resuelve términos de negocio (sinónimos del catálogo) presentes en un texto.
 * Coincidencia por palabra completa, del término más largo al más corto, para que
 * "margen ebitda" tenga prioridad sobre "ebitda". El orden del resultado sigue la aparición en el texto.
 */
export function resolveTerms(text: string, catalog: Catalog): ResolvedTerms {
  let t = ` ${normalizeText(text).replace(/[^a-z0-9ñ ]/g, ' ')} `;
  const found: Array<{ pos: number; type: string; code: string }> = [];
  const terms = [...catalog.synonyms].sort((a, b) => b.term.length - a.term.length);
  for (const s of terms) {
    const needle = ` ${normalizeText(s.term)} `;
    let idx = t.indexOf(needle);
    while (idx >= 0) {
      found.push({ pos: idx, type: s.targetType, code: s.targetCode });
      t = t.slice(0, idx) + ' ' + '_'.repeat(needle.length - 2) + ' ' + t.slice(idx + needle.length);
      idx = t.indexOf(needle);
    }
  }
  // Códigos de métrica escritos literalmente (p.ej. "roic")
  for (const code of catalog.metrics.keys()) {
    const needle = ` ${code.replace(/_/g, ' ')} `;
    const idx = t.indexOf(needle);
    if (idx >= 0) found.push({ pos: idx, type: 'metric', code });
  }
  found.sort((a, b) => a.pos - b.pos);
  const uniq = (type: string) => [...new Set(found.filter((f) => f.type === type).map((f) => f.code))];
  return { metrics: uniq('metric'), dimensions: uniq('dimension'), charts: uniq('chart') };
}
