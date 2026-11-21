import type { AccountCategory, RateType } from '@nexora/shared';

export const ENGINE_VERSION = 'fe-1.0.0';

export interface Account {
  id: string;
  code: string;
  name: string;
  statement: 'PL' | 'BS';
  category: AccountCategory;
  isIntercompany: boolean;
  rateType: RateType;
  consolidationOnly: boolean;
}

export interface Company {
  id: string;
  code: string;
  name: string;
  countryCode: string;
  functionalCurrency: string;
}

/** Línea Silver validada (importe en moneda local, convención de signo natural de la cuenta). */
export interface Line {
  id: string;
  companyId: string;
  accountId: string;
  periodCode: string;
  amount: string;
  currency: string;
  counterpartyCode: string | null;
  icReference: string | null;
  lineHash: string;
}

export interface Rate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  periodCode: string | null;
  rateType: RateType;
  scenario: string;
  rate: string;
}

export interface Adjustment {
  id: string;
  companyId: string;
  accountId: string;
  periodCode: string;
  amount: string;
  description: string;
}

export interface IcAcceptance {
  icReference: string;
  sellerLineHash: string;
  buyerLineHash: string;
}

export interface ConsolidationInput {
  organizationId: string;
  versionId: string;
  fiscalYear: number;
  presentationCurrency: string;
  rateScenario: string;
  includesBalanceSheet: boolean;
  companies: Company[];
  accounts: Account[];
  lines: Line[];
  rates: Rate[];
  adjustments: Adjustment[];
  acceptances: IcAcceptance[];
  /** Parámetros aprobados (decimales serializados): nopat_tax_rate, cost_of_equity, cost_of_debt, ic_tolerance_abs, ic_tolerance_pct */
  parameters: Record<string, string>;
  rulesVersion: string;
}

export type EntryType = 'translation' | 'elimination' | 'cta' | 'adjustment';

export interface Entry {
  companyId: string;
  accountId: string;
  periodCode: string;
  entryType: EntryType;
  sourceLineId: string | null;
  icReference: string | null;
  adjustmentId: string | null;
  localAmount: string | null;
  localCurrency: string | null;
  rate: string | null;
  rateType: RateType | 'identity' | null;
  rateId: string | null;
  groupAmount: string;
  description: string;
}

export type IcStatus = 'matched' | 'mismatch' | 'unmatched' | 'accepted_difference';

export interface IcMatch {
  icReference: string;
  periodCode: string | null;
  sellerCompanyId: string | null;
  buyerCompanyId: string | null;
  sellerLineId: string | null;
  buyerLineId: string | null;
  sellerLineHash: string | null;
  buyerLineHash: string | null;
  sellerAmount: string | null;
  buyerAmount: string | null;
  difference: string | null;
  tolerance: string | null;
  status: IcStatus;
  reason: string;
}

export interface MissingRate {
  fromCurrency: string;
  toCurrency: string;
  rateType: RateType;
  periodCode: string | null;
  scenario: string;
  lineIds: string[];
  companyIds: string[];
}

export interface FinancialRow {
  companyId: string;
  accountId: string;
  periodCode: string;
  translated: string;
  elimination: string;
  cta: string;
  adjustment: string;
  total: string;
}

export interface MetricResult {
  metricCode: string;
  scope: 'group' | 'company';
  companyId: string | null;
  periodLabel: string;
  value: string | null;
  unit: 'currency' | 'ratio';
  status: 'calculated' | 'not_calculable';
  missing: string[];
  components: Record<string, string | null>;
}

export interface ConsolidationResult {
  entries: Entry[];
  financials: FinancialRow[];
  icMatches: IcMatch[];
  missingRates: MissingRate[];
  metrics: MetricResult[];
  ratesApplied: Array<Pick<Rate, 'id' | 'fromCurrency' | 'toCurrency' | 'periodCode' | 'rateType' | 'rate' | 'scenario'>>;
  blockingReasons: string[];
  inputsHash: string;
  summary: Record<string, string | number>;
}
