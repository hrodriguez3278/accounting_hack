import { z } from 'zod';

export const Severity = z.enum(['critical', 'warning', 'informational']);
export type Severity = z.infer<typeof Severity>;

export const RunStatus = z.enum([
  'draft', 'validating', 'blocked', 'ready_for_review', 'approved', 'published', 'failed', 'superseded',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** Transiciones autorizadas (espejo del trigger gold.check_run_transition). */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  draft: ['validating', 'failed'],
  validating: ['blocked', 'ready_for_review', 'failed'],
  blocked: [],
  ready_for_review: ['approved', 'blocked'],
  approved: ['published'],
  published: ['superseded'],
  failed: [],
  superseded: [],
};

export const AccountCategory = z.enum([
  'revenue', 'cogs', 'opex', 'da', 'interest', 'other', 'tax',
  'cash', 'receivables', 'inventory', 'ppe', 'payables', 'debt', 'equity', 'cta',
]);
export type AccountCategory = z.infer<typeof AccountCategory>;

export const RateType = z.enum(['average', 'closing', 'historical']);
export type RateType = z.infer<typeof RateType>;

export const PL_CATEGORIES: readonly AccountCategory[] = ['revenue', 'cogs', 'opex', 'da', 'interest', 'other', 'tax'];
export const ASSET_CATEGORIES: readonly AccountCategory[] = ['cash', 'receivables', 'inventory', 'ppe'];
export const LIABILITY_CATEGORIES: readonly AccountCategory[] = ['payables', 'debt'];
/** Categorías del lado "vendedor" en intercompañía. */
export const IC_SELLER_CATEGORIES: readonly AccountCategory[] = ['revenue', 'receivables'];

export const PERMISSIONS = [
  'org.admin', 'company.manage', 'data.upload', 'data.read', 'mapping.manage', 'rates.manage',
  'quality.review', 'quality.resolve', 'quality.approve', 'consolidation.run', 'consolidation.approve',
  'consolidation.publish', 'adjustment.propose', 'adjustment.approve', 'financial.read', 'semantic.query',
  'metric.approve', 'dashboard.create', 'dashboard.share', 'ai.use', 'scenario.create', 'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Clasificación epistemológica de afirmaciones del analista IA. */
export const ClaimKind = z.enum(['verified_cause', 'observed_correlation', 'hypothesis', 'data_unavailable']);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const DataNature = z.enum(['official', 'projection', 'simulation', 'assumption']);
export type DataNature = z.infer<typeof DataNature>;
