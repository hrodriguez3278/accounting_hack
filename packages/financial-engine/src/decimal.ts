import DecimalJs from 'decimal.js';

/** Decimal con 34 dígitos significativos (equivalente a decimal128). Nunca se usa coma flotante para importes. */
export const Decimal = DecimalJs.clone({ precision: 34, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

export const D = (v: string | number | Decimal): Decimal => new Decimal(v);

/** Serialización estable: sin notación exponencial, sin ceros finales superfluos. */
export function toStr(v: Decimal): string {
  const s = v.toFixed();
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((a, b) => a.plus(b), D(0));
}
