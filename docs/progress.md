# Progreso — 21/11/2026

Estado verificado en local (Supabase CLI 2.114, PostgreSQL 17, Node 24, Edge para E2E).

| Fase | Estado | Evidencia |
|---|---|---|
| 1. Fundamentos | ✅ | 5 migraciones, 55 tablas en 9 esquemas, RLS en todas; Auth email/contraseña + recuperación; layout Íntegro claro/oscuro |
| 2. Data Hub | ✅ | CSV (coma/punto y coma, decimales con coma) y XLSX; Storage privado con SHA-256; mapeo de columnas sugerido y reutilizable; lotes de 500 filas idempotentes y reprocesables; historial |
| 3. Motor financiero | ✅ | 15 reglas; 8 errores sembrados detectados; bloqueo; resolución autorizada; traducción por tipo de tasa; IC con tolerancia y aceptación; CTA; ajustes; estados y transiciones; hash reproducible |
| 4. Capa semántica | ✅ | 18 métricas con fórmula aprobada, 4 dimensiones, sinónimos, `POST /api/semantic/query`, procedencia, no calculables explicados |
| 5. Dashboards | ✅ | 12 tipos de widget (ECharts + tablas/KPI), crear/renombrar/duplicar/eliminar/compartir/reordenar/tamaño, historial y restauración, filtros globales |
| 6. IA | ✅ | 14 herramientas autorizadas, analista con verificación de cifras y evidencias, estudio de dashboards por lenguaje natural, confirmación de cambios destructivos. Verificado con OpenAI (gpt-4.1-mini) |
| 7. Escenarios | ✅ | 8 supuestos, fórmulas explícitas, comparación base vs. simulación, escenario incompleto |
| 8. Calidad y despliegue | ✅ | Documentación, imágenes Docker de API y web verificadas, carga demo automática al desplegar; ver `pending.md` |

## Verificación

Antes de retirar la suite de pruebas del repositorio (a solicitud del responsable, para dejarlo limpio) se ejecutaron por última vez con los datos demo definitivos: 46 pruebas unitarias y de integración y 5 de navegador, todas aprobadas. El repositorio conserva `npm run typecheck` y la carga demo idempotente (`deploy:seed`). Las imágenes Docker de API y web se construyeron y arrancaron correctamente.

## Resultados demo (verificados contra cálculo independiente)

| Versión | Ingresos USD | EBITDA USD | ROIC | EVA USD |
|---|---:|---:|---:|---:|
| PRES-2027-V1 | 53,228,266.33 | 6,891,748.35 | 11.11 % | 230,435.07 |
| PRES-2027-V2 | 52,864,191.65 | 7,175,811.24 | 11.92 % | 458,194.15 |
| PROY-2027 | 53,260,918.61 | 6,720,358.61 | no calculable (sin balance) | no calculable |
