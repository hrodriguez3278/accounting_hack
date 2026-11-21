import postgres from 'postgres';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

/**
 * Local: sin SSL. Hospedado (Supabase en la nube): SSL obligatorio.
 * Pooler en modo transacción (puerto 6543): sin sentencias preparadas. Las transacciones con SET LOCAL ROLE funcionan en ambos modos.
 */
export function createSql(url: string, opts: { max?: number } = {}): Sql {
  const u = new URL(url);
  const local = ['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(u.hostname);
  const ssl = process.env.DATABASE_SSL ? process.env.DATABASE_SSL !== 'false' : !local;
  const prepare = process.env.DATABASE_PREPARE ? process.env.DATABASE_PREPARE !== 'false' : u.port !== '6543';
  return postgres(url, {
    max: opts.max ?? 10,
    ssl: ssl ? 'require' : false,
    prepare,
    idle_timeout: 20,
    onnotice: () => undefined,
    connection: { application_name: 'nexora-ai' },
  });
}

/**
 * Ejecuta `fn` dentro de una transacción con la identidad del usuario: SET LOCAL ROLE authenticated
 * y request.jwt.claims, de modo que auth.uid() y las políticas RLS se aplican a todas las lecturas.
 */
export async function withUser<T>(sql: Sql, userId: string, fn: (tx: Tx) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
    await tx`select set_config('statement_timeout', ${String(opts.timeoutMs ?? 15000)}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  }) as Promise<T>;
}

export const json = (v: unknown): string => JSON.stringify(v);

// ---------------------------------------------------------------- adaptadores (Supabase hoy, Microsoft Fabric mañana)

/** Almacenamiento de archivos originales (Bronze). */
export interface StorageAdapter {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
}

/** Fuente de datos estructurados de origen (filas Bronze). */
export interface SourceDataAdapter {
  rawRows(sourceFileId: string, fromRow: number, limit: number): Promise<Array<{ id: string; rowNumber: number; data: Record<string, string> }>>;
}

/** Ingesta por lotes recuperable. */
export interface IngestionAdapter {
  insertRawRows(sourceFileId: string, rows: Array<{ rowNumber: number; data: Record<string, string>; rowHash: string }>): Promise<number>;
}

export class SupabaseStorageAdapter implements StorageAdapter {
  constructor(private readonly client: SupabaseClient, private readonly bucket = 'budget-files') {}

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(path, bytes, { contentType, upsert: false });
    if (error && !/exists|Duplicate/i.test(error.message)) throw new Error(`Storage: ${error.message}`);
  }

  async get(path: string): Promise<Uint8Array> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) throw new Error(`Storage: ${error?.message ?? 'archivo no encontrado'}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async exists(path: string): Promise<boolean> {
    const dir = path.split('/').slice(0, -1).join('/');
    const name = path.split('/').pop()!;
    const { data } = await this.client.storage.from(this.bucket).list(dir, { search: name });
    return !!data?.some((f) => f.name === name);
  }
}

/** Cliente administrativo de Supabase. SOLO servidor: usa la clave secreta. */
export function createAdminClient(url: string, secretKey: string): SupabaseClient {
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
