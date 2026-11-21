import type { BridgeEntry, FinancialRow, Account, Company } from '@nexora/financial-engine';

export interface CatalogMetric {
  code: string;
  name: string;
  description: string;
  unit: 'currency' | 'ratio';
  category: string;
  higherIsBetter: boolean;
  version: number | null;      // versión aprobada vigente (null = sin versión aprobada)
  formula: string | null;
  components: string[];
  dimensions: string[];
}

export interface Catalog {
  metrics: Map<string, CatalogMetric>;
  dimensions: Map<string, { code: string; name: string; description: string }>;
  synonyms: Array<{ term: string; targetType: 'metric' | 'dimension' | 'chart'; targetCode: string }>;
}

export interface VersionInfo {
  id: string;
  code: string;
  name: string;
  kind: 'budget' | 'forecast' | 'actual';
  fiscalYear: number;
  rateScenario: string;
  includesBalanceSheet: boolean;
}

export interface RunInfo {
  id: string;
  status: string;
  versionId: string;
  presentationCurrency: string;
  finishedAt: string | null;
  inputsHash: string | null;
}

export interface QueryContext {
  organizationId: string;
  userId: string;
  hasAllCompanies: boolean;
  accessibleCompanyIds: Set<string>;
  source: 'ui' | 'ai' | 'dashboard' | 'api' | 'test';
}

/**
 * Adaptador de consulta financiera. Implementación actual: PostgreSQL/Supabase (apps/api).
 * Una implementación futura sobre Microsoft Fabric debe cumplir el mismo contrato.
 */
export interface FinancialQueryAdapter {
  loadCatalog(): Promise<Catalog>;
  resolveVersion(organizationId: string, code: string, fiscalYear: number): Promise<VersionInfo | null>;
  /** Corrida preferente: publicada; si no hay, la más reciente aprobada o lista para revisión. */
  resolveRun(organizationId: string, versionId: string): Promise<RunInfo | null>;
  loadFinancials(runId: string): Promise<FinancialRow[]>;
  loadBridgeEntries(runId: string): Promise<BridgeEntry[]>;
  loadRatesApplied(runId: string): Promise<Array<{ fromCurrency: string; rateType: string; periodCode: string | null; rate: string }>>;
  loadAccounts(organizationId: string): Promise<Account[]>;
  loadCompanies(organizationId: string): Promise<Company[]>;
  loadParameters(organizationId: string, fiscalYear: number): Promise<Record<string, string>>;
  logQuery(entry: {
    organizationId: string; userId: string; source: QueryContext['source']; request: unknown; runIds: string[];
    rowCount: number | null; durationMs: number; status: 'ok' | 'rejected' | 'error'; error?: string;
  }): Promise<string>;
}

export class SemanticError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}
