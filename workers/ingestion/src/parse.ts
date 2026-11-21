import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { numberToDecimalString, parseAmount, parsePeriod, type ColumnMappingConfig } from '@nexora/shared';

export type FileKind = 'csv' | 'xlsx';

export interface RawTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  sheet?: string;
}

export const MAX_ROWS = 200_000;

export function sha256(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function detectKind(fileName: string): FileKind | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.csv') || n.endsWith('.txt')) return 'csv';
  if (n.endsWith('.xlsx')) return 'xlsx';
  return null;
}

/** Detecta el delimitador más probable en la primera línea. */
export function sniffDelimiter(text: string): ',' | ';' | '\t' | '|' {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = ([',', ';', '\t', '|'] as const).map((d) => [d, first.split(d).length] as const);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Lee un archivo sin interpretar su contenido: todos los valores se conservan como texto. */
export async function readTable(buf: Uint8Array, kind: FileKind, opts: { delimiter?: string; sheet?: string } = {}): Promise<RawTable> {
  if (kind === 'csv') {
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delimiter = opts.delimiter ?? sniffDelimiter(text);
    const parsed = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: 'greedy' });
    const [header, ...data] = parsed.data;
    if (!header) throw new Error('El archivo está vacío');
    const headers = header.map((h) => h.trim());
    assertHeaders(headers);
    if (data.length > MAX_ROWS) throw new Error(`El archivo supera el máximo de ${MAX_ROWS} filas`);
    return { headers, rows: data.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf) as unknown as ArrayBuffer);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  if (!ws) throw new Error(`No se encontró la hoja ${opts.sheet ?? ''}`.trim());
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = cellText(cell.value).trim(); });
  assertHeaders(headers);
  const rows: Array<Record<string, string>> = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      const v = cellText(row.getCell(i + 1).value);
      if (v !== '') any = true;
      rec[h] = v;
    });
    if (any) rows.push(rec);
    if (rows.length > MAX_ROWS) throw new Error(`El archivo supera el máximo de ${MAX_ROWS} filas`);
  }
  return { headers, rows, sheet: ws.name };
}

function assertHeaders(headers: string[]): void {
  if (!headers.length || headers.every((h) => !h)) throw new Error('No se encontró una fila de encabezados');
  const dup = headers.find((h, i) => h && headers.indexOf(h) !== i);
  if (dup) throw new Error(`Encabezado duplicado: ${dup}`);
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return numberToDecimalString(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  return String(v);
}

export interface CanonicalRow {
  account_code: string | null;
  account_name: string | null;
  period_raw: string | null;
  period_code: string | null;
  amount_raw: string | null;
  amount: string | null;
  currency: string | null;
  counterparty_code: string | null;
  ic_reference: string | null;
  company_code: string | null;
}

const val = (row: Record<string, string>, col?: string): string | null => {
  if (!col) return null;
  const v = row[col];
  return v === undefined || v.trim() === '' ? null : v.trim();
};

/** Aplica el mapeo de columnas al modelo canónico. No corrige valores: solo interpreta formatos declarados. */
export function toCanonical(row: Record<string, string>, m: ColumnMappingConfig): CanonicalRow {
  const periodRaw = val(row, m.columns.period);
  const amountRaw = val(row, m.columns.amount);
  return {
    account_code: val(row, m.columns.account_code),
    account_name: val(row, m.columns.account_name),
    period_raw: periodRaw,
    period_code: parsePeriod(periodRaw, m.period_format),
    amount_raw: amountRaw,
    amount: parseAmount(amountRaw, m.decimal_separator, m.thousands_separator ?? ''),
    currency: val(row, m.columns.currency)?.toUpperCase() ?? m.default_currency ?? null,
    counterparty_code: val(row, m.columns.counterparty_code),
    ic_reference: val(row, m.columns.ic_reference),
    company_code: val(row, m.columns.company_code),
  };
}

export function missingMappedColumns(headers: string[], m: ColumnMappingConfig): string[] {
  return Object.entries(m.columns).filter(([, col]) => col && !headers.includes(col)).map(([field, col]) => `${field} → "${col}"`);
}

const HINTS: Record<keyof ColumnMappingConfig['columns'], RegExp> = {
  account_code: /^(cuenta( contable)?|c(o|ó)digo[ _]?cuenta|codigo_cuenta|cta|account( code)?|account_code)$/i,
  account_name: /^(descripci(o|ó)n|nombre([ _]cuenta)?|concepto|account name|account_name)$/i,
  period: /^(mes|periodo|período|period|fecha)$/i,
  amount: /^(importe|monto|valor|amount|saldo)$/i,
  currency: /^(moneda|divisa|currency)$/i,
  counterparty_code: /^(contraparte|cia[ _]relacionada|socio ic|ic partner|counterparty)$/i,
  ic_reference: /^(referencia ic|doc[ _]ic|ref ic|ic ref|ic_reference)$/i,
  company_code: /^(empresa|compa(ñ|n)(i|í)a|company)$/i,
};

/** Sugerencia heurística de mapeo (el usuario la confirma antes de importar). */
export function suggestMapping(headers: string[]): Partial<ColumnMappingConfig['columns']> {
  const out: Partial<ColumnMappingConfig['columns']> = {};
  for (const [field, re] of Object.entries(HINTS) as Array<[keyof ColumnMappingConfig['columns'], RegExp]>) {
    const h = headers.find((x) => re.test(x.trim()));
    if (h) out[field] = h;
  }
  return out;
}

export function rowHash(row: Record<string, string>): string {
  return sha256(JSON.stringify(Object.entries(row)));
}
