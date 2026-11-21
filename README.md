# NEXORA AI

Plataforma de consolidación e inteligencia financiera generativa para grupos empresariales: consolidación automática multiempresa y multimoneda, información verificable hasta el archivo original y dashboards creados con lenguaje natural.

> **Datos de demostración 100 % ficticios** (Grupo Altavista DEMO). No representan empresas ni cifras reales.

## Empresas de la demostración

| Código | Empresa | País | Moneda | Rol en el grupo |
|---|---|---|---|---|
| ALT-ALIM | Altavista Alimentos, S.A. | Guatemala | GTQ | Fabricante; vende producto a la distribuidora |
| ALT-LOGI | Altavista Logística, S.A. | Guatemala | GTQ | Transporte y almacenamiento |
| ALT-COMR | Altavista Comercial de Honduras, S. de R.L. | Honduras | HNL | Comercialización |
| ALT-SERV | Altavista Servicios Compartidos, S. de R.L. | Honduras | HNL | Servicios administrativos |
| ALT-DIST | Altavista Distribuidora, S.A. de C.V. | El Salvador | USD | Distribución regional |
| ALT-HOLD | Altavista Holding Corp. | Panamá | USD | Holding; cobra honorarios de gestión |

Versiones: **Presupuesto 2027 V1** (publicado), **Proyección de ejecución 2027** (publicada, sin balance) y **Presupuesto 2027 V2** (cargado con 8 errores sembrados para demostrar Calidad de datos).

Usuarios demo (la contraseña se define con `DEMO_PASSWORD` en `.env`; en cada carga demo se aplica también a los usuarios existentes):

| Usuario | Rol | Alcance |
|---|---|---|
| director@altavista.example | Dirección | Todas las empresas |
| admin@altavista.example | Administración financiera | Todas las empresas |
| analista@altavista.example | Analista | Solo ALT-ALIM y ALT-LOGI |
| auditor@altavista.example | Auditoría | Todas, lectura y auditoría |

## Ejecución local

Requisitos: Node.js ≥ 22 y Docker Desktop abierto.

```bash
npm install
npm run db:start        # Supabase local
npm run demo:setup      # base limpia + datos demo
npm run dev             # API :4000 + web :3000
```

## Despliegue

Ver **[docs/deployment.md](docs/deployment.md)**. En resumen:

1. Aplicar las migraciones al proyecto Supabase (`supabase db push`).
2. Configurar `.env` con las credenciales del proyecto y la llave de OpenAI.
3. `docker compose up -d --build`: la API carga los datos demo al arrancar (`SEED_DEMO=true`).

Todo despliegue debe ser provisto y validado por el equipo de **Transformación Digital** de Íntegro; no usar cuentas personales.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | API y web en modo desarrollo |
| `npm run demo:setup` | Reinicia la base local y carga los datos demo |
| `npm run deploy:seed` | Carga los datos demo en la base configurada (idempotente) |
| `npm run ai:check` | Verifica la llave y el modelo de OpenAI |
| `npm run typecheck` | Verificación de tipos |
| `npm run build:web` | Genera la web como sitio estático |
| `npm run demo:generate` | Regenera los archivos demo (requiere Python y openpyxl) |

## Estructura

```
apps/web          Interfaz (Nuxt 4, marca Íntegro)
apps/api          API REST (Fastify)
packages/         Motores: financiero, validación, capa semántica, dashboards e IA; contratos y acceso a datos
workers/          Lectura de archivos y consolidación por línea de comandos
supabase/         Migraciones y datos maestros de la demo
data/demo/        Archivos presupuestarios de las 6 empresas (3 versiones)
deploy/           Dockerfiles, nginx y arranque de la API
scripts/          Carga demo, generador de datos y utilidades
docs/             Arquitectura, reglas financieras, seguridad y despliegue
```
