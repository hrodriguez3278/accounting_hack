import type { SupabaseClient } from '@supabase/supabase-js';
import type { Permission } from '@nexora/shared';
import type { Db, Sql, StorageAdapter } from '@nexora/database';
import type { Env } from './env.js';
import { forbidden, HttpError } from './errors.js';

export interface Deps {
  env: Env;
  sql: Sql;
  admin: SupabaseClient;
  storage: StorageAdapter;
}

export interface AuthContext {
  userId: string;
  email: string;
  organizationId: string;
  presentationCurrency: string;
  role: string;
  permissions: Set<string>;
  allCompanies: boolean;
  companyIds: Set<string>;
  memberships: Array<{ organizationId: string; name: string; role: string }>;
}

export function requirePerm(ctx: AuthContext, perm: Permission): void {
  if (!ctx.permissions.has(perm)) throw forbidden(`Permiso requerido: ${perm}`);
}

export function requireCompany(ctx: AuthContext, companyId: string): void {
  if (!ctx.companyIds.has(companyId)) throw forbidden('Sin acceso a la empresa solicitada');
}

export function requireAllCompanies(ctx: AuthContext): void {
  if (!ctx.allCompanies) throw forbidden('La operación requiere acceso a todas las empresas del grupo');
}

const userCache = new Map<string, { userId: string; email: string; exp: number }>();

/** Verifica el JWT de Supabase Auth y resuelve la membresía en la organización solicitada. */
export async function authenticate(deps: Deps, authorization: string | undefined, orgHeader: string | undefined): Promise<AuthContext> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Sesión requerida');
  let cached = userCache.get(token);
  if (!cached || cached.exp < Date.now()) {
    const { data, error } = await deps.admin.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sesión inválida o expirada');
    cached = { userId: data.user.id, email: data.user.email ?? '', exp: Date.now() + 30_000 };
    userCache.set(token, cached);
    if (userCache.size > 5000) userCache.clear();
  }
  return loadMembership(deps.sql, cached.userId, cached.email, orgHeader);
}

export async function loadMembership(sql: Db, userId: string, email: string, orgHeader?: string): Promise<AuthContext> {
  const members = await sql<Array<{ organization_id: string; name: string; role_code: string; all_companies: boolean; presentation_currency: string }>>`
    select m.organization_id, o.name, m.role_code, m.all_companies, o.presentation_currency
    from core.organization_members m join core.organizations o on o.id = m.organization_id
    where m.user_id = ${userId} and m.status = 'active'
    order by o.name`;
  if (!members.length) throw forbidden('El usuario no pertenece a ninguna organización');
  const m = orgHeader ? members.find((x) => x.organization_id === orgHeader) : members[0];
  if (!m) throw forbidden('Sin acceso a la organización solicitada');
  const perms = await sql<Array<{ permission_code: string }>>`
    select permission_code from core.role_permissions where role_code = ${m.role_code}`;
  const companies = m.all_companies
    ? await sql<Array<{ id: string }>>`select id from core.companies where organization_id = ${m.organization_id} and is_active`
    : await sql<Array<{ id: string }>>`
        select a.company_id as id from core.company_access a
        where a.user_id = ${userId} and a.organization_id = ${m.organization_id}`;
  return {
    userId, email, organizationId: m.organization_id, presentationCurrency: m.presentation_currency, role: m.role_code,
    permissions: new Set(perms.map((p) => p.permission_code)), allCompanies: m.all_companies,
    companyIds: new Set(companies.map((c) => c.id)),
    memberships: members.map((x) => ({ organizationId: x.organization_id, name: x.name, role: x.role_code })),
  };
}

export async function audit(sql: Db, ctx: Pick<AuthContext, 'organizationId' | 'userId'>, action: string, entityType: string,
  entityId: string | null, details: Record<string, unknown> = {}): Promise<void> {
  await sql`insert into audit.audit_events (organization_id, user_id, action, entity_type, entity_id, details)
    values (${ctx.organizationId}, ${ctx.userId}, ${action}, ${entityType}, ${entityId}, ${JSON.stringify(details)}::text::jsonb)`;
}

export async function approvalEvent(sql: Db, ctx: Pick<AuthContext, 'organizationId' | 'userId'>, entityType: string, entityId: string,
  action: string, from: string | null, to: string | null, reason: string | null): Promise<void> {
  await sql`insert into audit.approval_events (organization_id, entity_type, entity_id, action, from_status, to_status, user_id, reason)
    values (${ctx.organizationId}, ${entityType}, ${entityId}, ${action}, ${from}, ${to}, ${ctx.userId}, ${reason})`;
}
