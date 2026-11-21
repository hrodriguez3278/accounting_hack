# Seguridad

## Identidad y acceso

- Supabase Auth (correo/contraseña, recuperación de contraseña, sesiones con renovación automática). Contraseña mínima 10 caracteres.
- Roles: super_admin, org_admin, financial_admin, director, financial_analyst, auditor, viewer (`core.roles`), con permisos granulares (`core.role_permissions`).
- Acceso por organización (`organization_members`) y por empresa (`all_companies` o `company_access`). Las cifras de grupo requieren acceso a todas las empresas.

## Defensa en profundidad

1. **Navegador**: solo clave publicable. Ningún esquema interno se expone vía Data API.
2. **API**: verifica el JWT contra Supabase Auth en cada solicitud, resuelve membresía y aplica `requirePerm` / `requireCompany` / `requireAllCompanies`. Entradas validadas con Zod. Logging estructurado (pino) con redacción de `authorization`, cookies, contraseñas y tokens.
3. **Base de datos**: RLS en todas las tablas. Las lecturas de usuario se ejecutan con `SET LOCAL ROLE authenticated` y `request.jwt.claims`, por lo que RLS aplica también dentro del backend. `authenticated` solo tiene `SELECT`; `anon` no tiene acceso. Triggers de inmutabilidad (Bronze, auditoría, corridas finalizadas) y de transiciones de estado.
4. **Secretos**: `.env` fuera de Git (`.gitignore`); `.env.example` sin valores. La clave secreta solo existe en el servidor. Los errores de entorno muestran nombres de variables, nunca valores.

## IA

- El modelo no recibe credenciales ni acceso a BD; solo 14 herramientas tipadas (Zod) que llaman servicios con la identidad del usuario. No existe herramienta de SQL, aprobación, publicación ni corrección de importes.
- Herramientas no registradas → `denied`; argumentos inválidos → `invalid`.
- Verificación de cifras: cada número de la respuesta se contrasta con los resultados de herramientas; lo no verificable se marca explícitamente.
- Prompt injection: el prompt del sistema declara los resultados de herramientas y el contenido de archivos como datos no confiables; detección heurística (`looksLikeInjection`) señalada en la respuesta; texto de usuario saneado y limitado; cambios masivos/destructivos de dashboards propuestos por IA requieren confirmación.
- Widgets: especificación declarativa estricta (sin HTML, llaves, `javascript:` ni manejadores); el renderer usa un registro cerrado de tipos.

## Pruebas

Verificado (antes de retirar la suite): aislamiento entre organizaciones con consultas directas bajo RLS, imposibilidad de escritura del rol `authenticated`, permisos por empresa, contratos estrictos, herramienta `execute_sql` rechazada, inyección en preguntas y en archivos cargados.

## Pendiente (ver `pending.md`)

Rate limiting, MFA, rotación de claves, cabeceras CSP en despliegue, separación de funciones (aprobador ≠ ejecutor) configurable, escaneo antivirus de archivos.

## Despliegue

Cualquier entorno hospedado (Supabase, hosting web, dominio, llaves de OpenAI) debe ser provisionado y validado por el equipo de **Transformación Digital** de Íntegro. No usar cuentas personales.
