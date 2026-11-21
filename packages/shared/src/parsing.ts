import type { PeriodFormat } from './contracts.js';

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** Convierte un periodo de origen al código canónico YYYY-MM. Devuelve null si no es interpretable. */
export function parsePeriod(raw: unknown, format: PeriodFormat): string | null {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  let y: string | undefined;
  let m: string | undefined;
  switch (format) {
    case 'YYYY-MM': [y, m] = v.split('-'); break;
    case 'YYYYMM': y = v.slice(0, 4); m = v.slice(4); break;
    case 'MM/YYYY': [m, y] = v.split('/'); break;
    case 'MON-YYYY': {
      const [mon, yy] = v.split('-');
      const idx = Math.max(MONTHS_EN.indexOf(mon ?? ''), MONTHS_ES.indexOf(mon ?? ''));
      if (idx < 0) return null;
      y = yy; m = String(idx + 1);
      break;
    }
  }
  if (!y || !m || !/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m)) return null;
  const mi = Number(m);
  if (mi < 1 || mi > 12) return null;
  return `${y}-${String(mi).padStart(2, '0')}`;
}

/**
 * Normaliza un importe textual a una cadena decimal canónica ("-1234.56").
 * No usa coma flotante. Devuelve null si el valor no es un número válido.
 */
export function parseAmount(raw: unknown, decimalSep: '.' | ',', thousandsSep: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? numberToDecimalString(raw) : null;
  let s = String(raw).trim().replace(/\s/g, '');
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (thousandsSep) s = s.split(thousandsSep).join('');
  if (decimalSep === ',') s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (negative) s = s.startsWith('-') ? s.slice(1) : `-${s}`;
  return s;
}

/** Representación decimal exacta de un number proveniente de una celda XLSX (máx. 15 dígitos significativos). */
export function numberToDecimalString(n: number): string {
  const s = n.toPrecision(15);
  if (/e/i.test(s)) return n.toFixed(6);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
