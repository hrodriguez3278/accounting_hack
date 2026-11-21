# Pendientes (explícitos)

## Requieren credenciales o decisión
- **OpenAI**: verificado con la llave real (analista y estudio de dashboards). Ollama sin probar.
- **Despliegue**: imágenes Docker, carga demo automática y guía (`docs/deployment.md`) listas. Falta que Transformación Digital provisione Supabase y el hosting y entregue credenciales.
- **Archivos oficiales del reto**: cuando se entreguen los seis archivos, cargarlos por el Data Hub (no sustituir por sintéticos) y recalcular `expected_results.py` con sus reglas.
- **CA corporativa (FortiGate)**: instalar en el equipo para usar `registry.npmjs.org` directamente (ADR-010).

## Funcionalidad
- Utilidades no realizadas en inventarios: solo como ajuste manual aprobado; no hay UI para proponer/aprobar ajustes (la tabla y el motor sí los soportan).
- Separación de funciones configurable (quien ejecuta ≠ quien aprueba).
- Políticas configurables para publicar con advertencias (hoy: toda advertencia debe aceptarse).
- Aprobación de fórmulas nuevas de métricas desde la UI (hoy solo por migración/seed).
- Gestión de usuarios desde la UI (alta, rol, empresas); hoy lectura + script.
- Snapshots de valores de dashboards para vistas históricas (hoy los widgets consultan en vivo la versión configurada; el historial guarda la especificación).
- Exportación a Parquet / Fabric (solo diseñado, ADR-007).
- Procesamiento asíncrono con cola persistente: la ingesta corre en el proceso de la API (recuperable e idempotente) y existe un worker CLI de consolidación; falta una cola dedicada.
- Escenarios por empresa (hoy a nivel grupo).

## Calidad y seguridad
- Linter (ESLint) no configurado; se usa typecheck estricto.
- Pruebas automatizadas retiradas del repositorio a solicitud; recomendable reincorporarlas en un repositorio o pipeline de QA antes de usar datos reales.
- Rate limiting, MFA, CSP, escaneo antivirus de cargas.
- Pruebas de rendimiento con volúmenes reales.
