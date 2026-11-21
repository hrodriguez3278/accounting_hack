import { createHash } from 'node:crypto';
import type { Severity } from '@nexora/shared';
import {
  D, fiscalMonths, findMissingRates, indexRates, lookupRate, matchIntercompany, openingPeriod,
  type Account, type Company, type IcAcceptance, type IcMatch, type Rate, type TranslatedLine,
} from '@nexora/financial-engine';

/** Línea Silver tal como sale de la normalización (antes de validar). */
export interface VLine {
  id: string;
  companyId: string;
  batchId: string;
  rawRowId: string;
  rowNumber: number;
  accountCode: string | null;
  periodRaw: string | null;
  periodCode: string | null;
  amountRaw: string | null;
  amount: string | null;
  currency: string | null;
  counterpartyCode: string | null;
  icReference: string | null;
  companyCodeInRow?: string | null;
  lineHash: string;
}

export interface RuleDef { code: string; severity: Severity; ruleVersion: number; isActive: boolean }

export interface ValidationContext {
  fiscalYear: number;
  presentationCurrency: string;
  rateScenario: string;
  companies: Company[];
  companyAccounts: Map<string, Set<string>>;        // companyId → códigos del catálogo de la empresa
  mappings: Map<string, string>;                    // `${companyId}|${code}` → accountId (solo aprobados)
  accounts: Account[];
  currencies: Set<string>;
  rates: Rate[];                                    // solo aprobadas
  acceptances: IcAcceptance[];
  parameters: Record<string, string>;
  rules: RuleDef[];
  companiesWithData: Set<string>;
}

export interface Issue {
  ruleCode: string;
  ruleVersion: number;
  severity: Severity;
  issueType: string;
  description: string;
  foundValue: string | null;
  expectedValue: string | null;
  fingerprint: string;
  companyId: string | null;
  lineId: string | null;
  rawRowId: string | null;
  batchId: string | null;
}

export interface ValidationOutput {
  issues: Issue[];
  /** accountId resuelto por línea (solo cuando existe mapeo aprobado). */
  resolvedAccounts: Map<string, string>;
  icMatches: IcMatch[];
  rulesVersion: string;
}

const NON_NEGATIVE = new Set(['revenue', 'cogs', 'opex', 'da', 'receivables', 'inventory', 'ppe', 'payables', 'debt']);

export function rulesVersion(rules: RuleDef[]): string {
  const active = rules.filter((r) => r.isActive).map((r) => `${r.code}@${r.ruleVersion}`).sort().join(',');
  return `rules-${createHash('sha256').update(active).digest('hex').slice(0, 12)}`;
}

export function validate(lines: VLine[], ctx: ValidationContext): ValidationOutput {
  const rules = new Map(ctx.rules.filter((r) => r.isActive).map((r) => [r.code, r]));
  const companies = new Map(ctx.companies.map((c) => [c.id, c]));
  const companyCodes = new Map(ctx.companies.map((c) => [c.code, c]));
  const accounts = new Map(ctx.accounts.map((a) => [a.id, a]));
  const months = new Set(fiscalMonths(ctx.fiscalYear));
  const opening = openingPeriod(ctx.fiscalYear);
  const issues: Issue[] = [];
  const resolved = new Map<string, string>();
  const lineHasCritical = new Set<string>();

  const emit = (code: string, l: VLine | null, description: string, found: string | null, expected: string | null,
    fingerprintKey: string, companyId?: string | null) => {
    const r = rules.get(code);
    if (!r) return;
    issues.push({
      ruleCode: code, ruleVersion: r.ruleVersion, severity: r.severity, issueType: code.toLowerCase(), description,
      foundValue: found, expectedValue: expected, fingerprint: `${code}|${fingerprintKey}`,
      companyId: companyId ?? l?.companyId ?? null, lineId: l?.id ?? null, rawRowId: l?.rawRowId ?? null, batchId: l?.batchId ?? null,
    });
    if (l && r.severity === 'critical') lineHasCritical.add(l.id);
  };

  // ---------------------------------------------------------------- reglas por línea
  const dupKeys = new Map<string, VLine>();
  for (const l of lines) {
    const company = companies.get(l.companyId)!;
    const where = `fila ${l.rowNumber}`;
    if (l.amount === null) emit('INVALID_AMOUNT', l, `Importe vacío o no numérico en ${where}`, l.amountRaw, 'Número decimal', l.id);
    if (l.periodCode === null) {
      emit('INVALID_PERIOD', l, `Periodo no interpretable en ${where}`, l.periodRaw, `${ctx.fiscalYear}-01 … ${ctx.fiscalYear}-12`, l.id);
    }
    if (l.currency === null || !ctx.currencies.has(l.currency)) {
      emit('UNKNOWN_CURRENCY', l, `Moneda '${l.currency ?? ''}' inexistente en el catálogo (${where})`, l.currency, company.functionalCurrency, l.id);
    } else if (l.currency !== company.functionalCurrency) {
      emit('CURRENCY_MISMATCH', l, `Moneda ${l.currency} distinta de la funcional de ${company.code} (${where})`, l.currency, company.functionalCurrency, l.id);
    }
    if (l.companyCodeInRow && l.companyCodeInRow !== company.code) {
      emit('UNKNOWN_COMPANY', l, `La fila declara la empresa '${l.companyCodeInRow}' en una carga de ${company.code}`, l.companyCodeInRow, company.code, l.id);
    }
    // Homologación
    let account: Account | undefined;
    if (l.accountCode) {
      const mapped = ctx.mappings.get(`${l.companyId}|${l.accountCode}`);
      if (mapped) {
        account = accounts.get(mapped);
        resolved.set(l.id, mapped);
      } else if (ctx.companyAccounts.get(l.companyId)?.has(l.accountCode)) {
        emit('UNMAPPED_ACCOUNT', l, `La cuenta ${l.accountCode} de ${company.code} no tiene homologación aprobada`, l.accountCode, 'Mapeo aprobado al catálogo corporativo', l.id);
      } else {
        emit('UNKNOWN_ACCOUNT', l, `La cuenta ${l.accountCode} no existe en el catálogo de ${company.code}`, l.accountCode, 'Cuenta del catálogo de la empresa', l.id);
      }
    } else {
      emit('UNKNOWN_ACCOUNT', l, `Fila sin código de cuenta (${where})`, null, 'Código de cuenta', l.id);
    }
    // Periodo según naturaleza de la cuenta
    if (l.periodCode && account) {
      const okPeriod = account.statement === 'PL' ? months.has(l.periodCode) : months.has(l.periodCode) || l.periodCode === opening;
      if (!okPeriod) {
        emit('INVALID_PERIOD', l, `Periodo ${l.periodCode} fuera del ejercicio ${ctx.fiscalYear} para una cuenta ${account.statement === 'PL' ? 'de resultados' : 'de balance'}`,
          l.periodCode, account.statement === 'PL' ? `${ctx.fiscalYear}-01 … ${ctx.fiscalYear}-12` : `${opening} … ${ctx.fiscalYear}-12`, l.id);
      }
    }
    // Signo
    if (account && l.amount !== null && NON_NEGATIVE.has(account.category) && D(l.amount).isNegative()) {
      emit('INCONSISTENT_SIGN', l, `Importe negativo en ${account.name} (${account.code}); el presupuesto se registra en signo natural positivo`,
        l.amountRaw, l.amount.replace(/^-/, ''), l.id);
    }
    // Intercompañía
    if (l.counterpartyCode) {
      const cp = companyCodes.get(l.counterpartyCode);
      if (!cp || cp.id === l.companyId) {
        emit('IC_COUNTERPARTY_UNKNOWN', l, `La contraparte '${l.counterpartyCode}' no es otra empresa del grupo`, l.counterpartyCode, 'Código de empresa del grupo', l.id);
      }
    }
    if (account?.isIntercompany && (!l.counterpartyCode || !l.icReference)) {
      emit('IC_MISSING_COUNTERPARTY', l, `La cuenta intercompañía ${account.code} requiere contraparte y referencia`, l.counterpartyCode ?? '', 'Contraparte y referencia IC', l.id);
    }
    // Duplicados (por contenido normalizado dentro de la versión)
    const k = [l.companyId, l.accountCode, l.periodCode, l.amount, l.currency, l.counterpartyCode ?? '', l.icReference ?? ''].join('|');
    const first = dupKeys.get(k);
    if (first) {
      emit('DUPLICATE_ROW', l, `Registro duplicado: igual a la fila ${first.rowNumber}`, `fila ${l.rowNumber}`, `Fila única (original: fila ${first.rowNumber})`, l.id);
    } else dupKeys.set(k, l);
  }

  // ---------------------------------------------------------------- reglas de versión
  const candidates = lines.filter((l) => !lineHasCritical.has(l.id) && resolved.has(l.id) && l.periodCode && l.amount !== null);
  const engineLines = candidates.map((l) => ({
    id: l.id, companyId: l.companyId, accountId: resolved.get(l.id)!, periodCode: l.periodCode!, amount: l.amount!,
    currency: l.currency!, counterpartyCode: l.counterpartyCode, icReference: l.icReference, lineHash: l.lineHash,
  }));
  const missing = findMissingRates({
    lines: engineLines, accounts: ctx.accounts, companies: ctx.companies, rates: ctx.rates,
    presentationCurrency: ctx.presentationCurrency, rateScenario: ctx.rateScenario,
  });
  const byLine = new Map(lines.map((l) => [l.id, l]));
  for (const m of missing) {
    const first = byLine.get(m.lineIds[0]!)!;
    emit('MISSING_FX_RATE', first,
      `Falta tasa ${m.rateType === 'average' ? 'promedio' : m.rateType === 'closing' ? 'de cierre' : 'histórica'} ${m.fromCurrency}→${m.toCurrency}` +
      `${m.periodCode ? ` para ${m.periodCode}` : ''} en el escenario ${m.scenario} (${m.lineIds.length} registros afectados)`,
      null, `Tasa aprobada ${m.fromCurrency}/${m.toCurrency} ${m.rateType} ${m.periodCode ?? ''}`.trim(),
      `${m.fromCurrency}|${m.toCurrency}|${m.rateType}|${m.periodCode ?? '-'}|${m.scenario}`, first.companyId);
  }

  // Conciliación IC sobre líneas traducibles
  const idx = indexRates(ctx.rates);
  const translated: TranslatedLine[] = [];
  const untranslatableRefs = new Set<string>();
  for (const l of engineLines) {
    const account = accounts.get(l.accountId)!;
    const company = companies.get(l.companyId)!;
    let rate = D(1);
    if (company.functionalCurrency !== ctx.presentationCurrency) {
      const r = lookupRate(idx, company.functionalCurrency, ctx.presentationCurrency, account.rateType, l.periodCode, ctx.rateScenario);
      if (!r) { if (l.icReference) untranslatableRefs.add(l.icReference); continue; }
      rate = D(r.rate);
    }
    translated.push({ ...l, groupAmount: D(l.amount).times(rate), account, company });
  }
  // Las líneas IC descartadas por errores críticos se reportan por su propia regla; su referencia no se evalúa aquí
  for (const l of lines) if (lineHasCritical.has(l.id) && l.icReference) untranslatableRefs.add(l.icReference);
  const icMatches = matchIntercompany(translated.filter((t) => !t.icReference || !untranslatableRefs.has(t.icReference)),
    ctx.companies, ctx.acceptances, ctx.parameters);
  for (const m of icMatches) {
    const line = byLine.get(m.sellerLineId ?? m.buyerLineId ?? '') ?? null;
    if (m.status === 'unmatched') {
      emit('IC_UNMATCHED', line, `Operación intercompañía ${m.icReference}: ${m.reason}`, m.sellerAmount ?? m.buyerAmount, 'Registro recíproco en la contraparte', m.icReference);
    } else if (m.status === 'mismatch') {
      emit('IC_MISMATCH', line, `Descuadre intercompañía ${m.icReference}: ${m.reason}`,
        `vendedor ${m.sellerAmount} / comprador ${m.buyerAmount}`, `Diferencia ≤ ${m.tolerance}`, m.icReference, m.sellerCompanyId);
    }
  }

  for (const c of ctx.companies) {
    if (!ctx.companiesWithData.has(c.id)) {
      emit('MISSING_COMPANY_FILE', null, `${c.code} no tiene carga procesada para la versión`, null, 'Carga procesada', c.id, c.id);
    }
  }

  return { issues, resolvedAccounts: resolved, icMatches, rulesVersion: rulesVersion(ctx.rules) };
}

/** Hash del contenido normalizado de una línea (cambia si se corrige cualquier campo). */
export function lineHash(l: Pick<VLine, 'companyId' | 'accountCode' | 'periodCode' | 'amount' | 'currency' | 'counterpartyCode' | 'icReference'> & { rawRowId: string }): string {
  return createHash('sha256').update(JSON.stringify([
    l.rawRowId, l.companyId, l.accountCode, l.periodCode, l.amount, l.currency, l.counterpartyCode ?? null, l.icReference ?? null,
  ])).digest('hex');
}
