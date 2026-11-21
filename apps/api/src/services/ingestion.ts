import { ColumnMappingConfig, CreateBatchRequest, REQUIRED_FIELDS } from '@nexora/shared';
import type { Sql } from '@nexora/database';
import { lineHash } from '@nexora/validation-engine';
import { detectKind, missingMappedColumns, readTable, rowHash, sha256, suggestMapping, toCanonical, type RawTable } from '@nexora/worker-ingestion';
import { audit, requireCompany, requirePerm, type AuthContext, type Deps } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { loadVersion } from './loaders.js';
import { validateVersion } from './validation.js';

const CHUNK = 500;
const MIME: Record<string, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const safeName = (n: string) => n.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-80) || 'archivo';

export interface UploadResult {
  source_file_id: string;
  duplicate: boolean;
  original_name: string;
  sha256: string;
  headers: string[];
  preview: Array<Record<string, string>>;
  row_count: number;
  suggested_mapping: Partial<ColumnMappingConfig['columns']>;
  saved_mapping: { id: string; name: string; config: ColumnMappingConfig } | null;
  sheet: string | null;
}

export async function uploadSourceFile(deps: Deps, ctx: AuthContext, input: { companyId: string; fileName: string; bytes: Uint8Array }): Promise<UploadResult> {
  requirePerm(ctx, 'data.upload');
  requireCompany(ctx, input.companyId);
  const kind = detectKind(input.fileName);
  if (!kind) throw badRequest('Formato no admitido: use CSV o XLSX');
  if (input.bytes.byteLength === 0) throw badRequest('El archivo está vacío');
  const hash = sha256(input.bytes);
  const { sql } = deps;

  let table: RawTable;
  try {
    table = await readTable(input.bytes, kind);
  } catch (e) {
    throw badRequest(`No se pudo leer el archivo: ${(e as Error).message}`);
  }

  const [existing] = await sql<Array<{ id: string; original_name: string }>>`
    select id, original_name from bronze.source_files
    where organization_id = ${ctx.organizationId} and company_id = ${input.companyId} and sha256 = ${hash}`;
  let fileId: string;
  if (existing) {
    fileId = existing.id;
    await audit(sql, ctx, 'file.duplicate_upload', 'source_file', fileId, { sha256: hash });
  } else {
    const path = `${ctx.organizationId}/${input.companyId}/${hash}/${safeName(input.fileName)}`;
    await deps.storage.put(path, input.bytes, MIME[kind]!);
    const [row] = await sql<Array<{ id: string }>>`
      insert into bronze.source_files (organization_id, company_id, storage_path, original_name, sha256, size_bytes, mime_type, uploaded_by)
      values (${ctx.organizationId}, ${input.companyId}, ${path}, ${input.fileName.slice(0, 200)}, ${hash}, ${input.bytes.byteLength},
              ${MIME[kind]!}, ${ctx.userId})
      returning id`;
    fileId = row!.id;
    await audit(sql, ctx, 'file.upload', 'source_file', fileId, { sha256: hash, size: input.bytes.byteLength });
  }

  const [saved] = await sql<Array<{ id: string; name: string; config: ColumnMappingConfig }>>`
    select id, name, config from bronze.column_mappings where company_id = ${input.companyId} and is_default
    order by updated_at desc limit 1`;
  return {
    source_file_id: fileId, duplicate: !!existing, original_name: existing?.original_name ?? input.fileName, sha256: hash,
    headers: table.headers, preview: table.rows.slice(0, 15), row_count: table.rows.length,
    suggested_mapping: suggestMapping(table.headers), saved_mapping: saved ?? null, sheet: table.sheet ?? null,
  };
}

export interface BatchRow {
  id: string;
  status: string;
  row_count: number | null;
  processed_rows: number;
  error: string | null;
  company_id: string;
  budget_version_id: string;
  source_file_id: string;
  created_at: string;
  finished_at: string | null;
}

/** Crea (o recupera, si ya existe) el lote para archivo + versión y lanza el procesamiento asíncrono. */
export async function createBatch(deps: Deps, ctx: AuthContext, raw: unknown, opts: { wait?: boolean } = {}): Promise<BatchRow & { reused: boolean }> {
  requirePerm(ctx, 'data.upload');
  const parsed = CreateBatchRequest.safeParse(raw);
  if (!parsed.success) throw badRequest('Solicitud inválida', parsed.error.issues);
  const req = parsed.data;
  requireCompany(ctx, req.company_id);
  const { sql } = deps;
  await loadVersion(sql, ctx.organizationId, req.budget_version_id);
  const [file] = await sql<Array<{ id: string; storage_path: string; original_name: string; company_id: string }>>`
    select id, storage_path, original_name, company_id from bronze.source_files
    where id = ${req.source_file_id} and organization_id = ${ctx.organizationId}`;
  if (!file || file.company_id !== req.company_id) throw notFound('Archivo no encontrado para la empresa');

  const [existing] = await sql<BatchRow[]>`select * from bronze.ingestion_batches
    where source_file_id = ${file.id} and budget_version_id = ${req.budget_version_id}`;
  if (existing && existing.status !== 'failed') {
    await audit(sql, ctx, 'batch.reuse', 'ingestion_batch', existing.id, { reason: 'mismo archivo y versión' });
    return { ...existing, reused: true };
  }

  const bytes = await deps.storage.get(file.storage_path);
  const table = await readTable(bytes, detectKind(file.original_name)!, { delimiter: req.mapping.delimiter, sheet: req.mapping.sheet });
  const missing = missingMappedColumns(table.headers, req.mapping);
  if (missing.length) throw badRequest(`Columnas mapeadas inexistentes en el archivo: ${missing.join(', ')}`);
  for (const f of REQUIRED_FIELDS) if (!req.mapping.columns[f]) throw badRequest(`Falta mapear el campo obligatorio ${f}`);

  let mappingId: string | null = null;
  if (req.save_mapping_as) {
    await sql`update bronze.column_mappings set is_default = false where company_id = ${req.company_id}`;
    const [m] = await sql<Array<{ id: string }>>`
      insert into bronze.column_mappings (organization_id, company_id, name, config, is_default, created_by)
      values (${ctx.organizationId}, ${req.company_id}, ${req.save_mapping_as}, ${JSON.stringify(req.mapping)}::text::jsonb, true, ${ctx.userId})
      on conflict (company_id, name) do update set config = excluded.config, is_default = true
      returning id`;
    mappingId = m!.id;
  }

  const batch = await sql.begin(async (tx) => {
    // Un nuevo archivo para la misma empresa y versión reemplaza (sin borrar) a la carga anterior
    await tx`update bronze.ingestion_batches set status = 'superseded'
      where company_id = ${req.company_id} and budget_version_id = ${req.budget_version_id} and status = 'processed'`;
    if (existing) {
      const [b] = await tx<BatchRow[]>`update bronze.ingestion_batches set status = 'uploaded', error = null,
          mapping_snapshot = ${JSON.stringify(req.mapping)}::text::jsonb, column_mapping_id = ${mappingId}
        where id = ${existing.id} returning *`;
      return b!;
    }
    const [b] = await tx<BatchRow[]>`
      insert into bronze.ingestion_batches (organization_id, company_id, budget_version_id, source_file_id, column_mapping_id,
        mapping_snapshot, declared_currency, row_count, created_by)
      values (${ctx.organizationId}, ${req.company_id}, ${req.budget_version_id}, ${file.id}, ${mappingId},
        ${JSON.stringify(req.mapping)}::text::jsonb, ${req.mapping.default_currency ?? null}, ${table.rows.length}, ${ctx.userId})
      returning *`;
    return b!;
  }) as BatchRow;
  await audit(sql, ctx, 'batch.create', 'ingestion_batch', batch.id, { source_file_id: file.id, version: req.budget_version_id });

  const job = processBatch(deps, batch.id, ctx.userId, table).catch(() => undefined);
  if (opts.wait) await job;
  const [fresh] = await sql<BatchRow[]>`select * from bronze.ingestion_batches where id = ${batch.id}`;
  return { ...fresh!, reused: false };
}

/**
 * Procesamiento recuperable por bloques: Bronze (filas originales) → Silver (modelo canónico).
 * Todas las inserciones son idempotentes, por lo que un lote fallido puede reprocesarse sin duplicar.
 */
export async function processBatch(deps: Deps, batchId: string, userId: string | null, preloaded?: RawTable): Promise<void> {
  const { sql } = deps;
  const [b] = await sql<Array<BatchRow & { organization_id: string; mapping_snapshot: ColumnMappingConfig }>>`
    update bronze.ingestion_batches set status = 'processing', started_at = now(), error = null
    where id = ${batchId} returning *`;
  if (!b) throw notFound('Lote no encontrado');
  try {
    const mapping = ColumnMappingConfig.parse(b.mapping_snapshot);
    let table = preloaded;
    if (!table) {
      const [f] = await sql<Array<{ storage_path: string; original_name: string }>>`
        select storage_path, original_name from bronze.source_files where id = ${b.source_file_id}`;
      table = await readTable(await deps.storage.get(f!.storage_path), detectKind(f!.original_name)!, { delimiter: mapping.delimiter, sheet: mapping.sheet });
    }
    for (let i = 0; i < table.rows.length; i += CHUNK) {
      const chunk = table.rows.slice(i, i + CHUNK).map((data, j) => ({ rowNumber: i + j + 1, data }));
      await sql.begin(async (tx) => {
        await tx`insert into bronze.raw_budget_rows ${tx(chunk.map((r) => ({
          source_file_id: b.source_file_id, row_number: r.rowNumber, data: r.data, row_hash: rowHash(r.data),
        })))} on conflict (source_file_id, row_number) do nothing`;
        const ids = await tx<Array<{ id: string; row_number: number }>>`
          select id, row_number from bronze.raw_budget_rows
          where source_file_id = ${b.source_file_id} and row_number between ${chunk[0]!.rowNumber} and ${chunk.at(-1)!.rowNumber}`;
        const idByRow = new Map(ids.map((x) => [x.row_number, x.id]));
        const lines = chunk.map((r) => {
          const c = toCanonical(r.data, mapping);
          const rawRowId = idByRow.get(r.rowNumber)!;
          return {
            organization_id: b.organization_id, batch_id: b.id, raw_row_id: rawRowId, company_id: b.company_id,
            budget_version_id: b.budget_version_id, row_number: r.rowNumber, account_code: c.account_code, account_name: c.account_name,
            period_raw: c.period_raw, period_code: c.period_code, amount_raw: c.amount_raw, amount: c.amount, currency: c.currency,
            counterparty_code: c.counterparty_code, ic_reference: c.ic_reference,
            line_hash: lineHash({ rawRowId, companyId: b.company_id, accountCode: c.account_code, periodCode: c.period_code,
              amount: c.amount, currency: c.currency, counterpartyCode: c.counterparty_code, icReference: c.ic_reference }),
          };
        });
        await tx`insert into silver.normalized_budget_lines ${tx(lines)} on conflict (batch_id, raw_row_id) do nothing`;
        await tx`update bronze.ingestion_batches set processed_rows = ${Math.min(i + CHUNK, table!.rows.length)} where id = ${b.id}`;
      });
    }
    await sql`update bronze.ingestion_batches set status = 'processed', finished_at = now(), row_count = ${table.rows.length}
      where id = ${b.id}`;
    await validateVersion(sql, b.organization_id, b.budget_version_id, userId);
  } catch (e) {
    await sql`update bronze.ingestion_batches set status = 'failed', error = ${(e as Error).message.slice(0, 500)}, finished_at = now()
      where id = ${b.id}`;
    throw e;
  }
}
