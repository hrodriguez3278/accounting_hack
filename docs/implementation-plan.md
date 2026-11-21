# NEXORA AI — Plan de implementación

Cada fase deja funcionalidad ejecutable y verificada. El estado real está en `progress.md`; lo que falta, en `pending.md`.

| Fase | Entregable verificable | Verificación |
|---|---|---|
| 1. Fundamentos | Monorepo npm workspaces, Supabase local, migraciones de todos los esquemas, RLS, Auth email/contraseña, layout Nuxt con marca Íntegro | `supabase db reset` sin errores; prueba RLS entre organizaciones; login real |
| 2. Data Hub | Carga CSV/XLSX → Storage privado → Bronze → Silver con mapeo de columnas reutilizable; idempotencia por hash | Integración: 6 archivos cargados; recarga del mismo archivo no duplica |
| 3. Motor financiero | Validaciones (8 errores sembrados), homologación, traducción, IC, CTA, ajustes, estados de corrida, métricas | Unit + integración contra `resultados esperados` calculado por script Python independiente |
| 4. Capa semántica | Catálogo de métricas/dimensiones/sinónimos en BD, `POST /api/semantic/query`, procedencia, drill-down | Integración: KPI vía API con `lineage_reference`; métricas no calculables explicadas |
| 5. Dashboards | Motor de spec declarativa, 12 tipos de widget, renderer ECharts seguro, versiones y restauración | Unit de esquemas; integración guardar/restaurar |
| 6. IA | Proveedores OpenAI / Ollama / reglas locales; herramientas autorizadas; verificación de cifras citadas | Crear y modificar widget por IA; pruebas de prompt injection |
| 7. Escenarios | Supuestos explícitos, recálculo determinista, comparación base vs. escenario | Unit con resultados esperados; aprobado intacto |
| 8. Calidad y despliegue | Seguridad, documentación, imágenes Docker, carga demo automática | Imágenes construidas y verificadas |

## Orden de construcción dentro de cada fase

1. Contrato Zod en `@nexora/shared`.
2. Lógica pura en el paquete del motor + pruebas unitarias.
3. Persistencia (migración) + servicio API + autorización.
4. Pantalla conectada con estados de carga/vacío/error.

## Datos de demostración

- `scripts/generate_demo_data.py` genera de forma determinista 6 empresas × 3 versiones (Presupuesto V1, Presupuesto V2, Proyección) con estructuras de columnas distintas y los 8 errores sembrados en V2.
- `data/demo/manifest.json` lista los errores esperados.
- `scripts/deploy-seed.ts` carga los datos demo por el pipeline real en cualquier entorno (idempotente).
