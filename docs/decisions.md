# Decisiones de arquitectura (ADR resumidos)

**ADR-001 · Monorepo con npm workspaces.** pnpm no estaba instalado; npm 11 cubre workspaces sin dependencias extra. Los paquetes exportan TypeScript fuente (sin paso de build); la API corre con `tsx`, la web con Vite.

**ADR-002 · API Fastify separada de Nuxt.** El enunciado pide `apps/api` Node REST. Fastify + Zod + pino. La web es SPA (`ssr: false`): todos los datos financieros requieren JWT del usuario.

**ADR-003 · RLS también en el backend.** Las lecturas se ejecutan con `SET LOCAL ROLE authenticated` + claims; un error de autorización en código no expone datos de otra organización. Las escrituras del motor usan el rol privilegiado tras autorización explícita.

**ADR-004 · `raw_budget_rows` = registros fuente.** Se fusionaron `source_records` y `raw_budget_rows`: una fila original por fila del archivo, ligada al archivo (no al lote) para que la misma carga reutilizada no duplique Bronze.

**ADR-005 · Conciliaciones IC inmutables por validación.** Revalidar crea una instantánea nueva (`validation_run_id`); los asientos publicados siguen apuntando a la suya. Vista `current_intercompany_matches` para la vigente. (Descubierto por la prueba de re-ejecución: borrar y reinsertar rompía la FK.)

**ADR-006 · Versionado de dashboards por instantánea completa** (`dashboard_versions`) en lugar de `widget_versions`: restaurar es atómico y auditable.

**ADR-007 · Preparación para Microsoft Fabric.** Contratos `FinancialQueryAdapter` (semantic-engine), `StorageAdapter`, `SourceDataAdapter`, `IngestionAdapter` (database). Plan: (1) replicar Bronze/Silver/Gold a OneLake (Delta) vía Data Factory; (2) implementar `FabricFinancialQueryAdapter` sobre el SQL endpoint del Lakehouse/Warehouse; (3) cambiar el adaptador en la API sin tocar IA ni dashboards; (4) mantener Supabase Auth o migrar a Entra ID con el mismo modelo de permisos. No se ejecuta ahora.

**ADR-008 · Proveedor de IA local determinista.** Sin `OPENAI_API_KEY` (o con `AI_PROVIDER=local`) el sistema usa reglas + catálogo semántico para interpretar español y redacta solo con resultados de herramientas. Permite demo y pruebas sin red ni costos; OpenAI y Ollama (endpoint compatible) usan el mismo contrato de herramientas.

**ADR-009 · Paleta de gráficos acromática de marca.** El skill Íntegro manda negro/gris/gris claro/rojo. El validador de paletas marca "chroma floor" (es acromática por diseño); prevalece la marca y se compensa con codificación secundaria obligatoria: leyenda, rótulos directos selectivos, línea discontinua para la segunda serie, textura en simulaciones y vista de tabla en todos los gráficos.

**ADR-010 · Red corporativa.** `registry.npmjs.org` es interceptado por un FortiGate cuya CA no está instalada en el equipo. No se desactivó TLS: las dependencias se instalaron desde `registry.yarnpkg.com` (espejo oficial con los mismos hashes de integridad). El `package-lock.json` refleja ese origen. Recomendado: que TI instale la CA corporativa.

**ADR-011 · Diferencias IC aceptadas a 8100.** Mantienen la utilidad consolidada igual a la suma individual (la diferencia queda visible como partida no operativa) hasta que la empresa corrija; preferible a forzar el importe de una de las partes.

**ADR-012 · Corridas nuevas, nunca sobrescritura.** Cada ejecución crea una corrida; publicar una nueva reemplaza (`superseded`) a la anterior. La aprobación/publicación recalcula el hash y rechaza si los datos cambiaron.
