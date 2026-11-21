# Despliegue de NEXORA AI

**Audiencia:** equipo de Transformación Digital de Íntegro. El proyecto Supabase, el hosting, los dominios y los secretos se provisionan con cuentas organizacionales y los valida este equipo.

## Componentes

| Componente | Imagen | Puerto | Notas |
|---|---|---|---|
| API | `deploy/api.Dockerfile` | 4000 (o `PORT`) | Node 24. Con `SEED_DEMO=true` carga los datos demo antes de iniciar. Healthcheck `/api/health` |
| Web | `deploy/web.Dockerfile` | 80 | Sitio estático (Nuxt generate) servido por nginx; las variables `NUXT_PUBLIC_*` se incrustan al compilar |
| Base de datos, Auth y Storage | Supabase | — | Proyecto provisto por Transformación Digital |

## 1. Supabase

1. **Authentication → URL Configuration:** *Site URL* = URL pública de la web; agregar `<web>/auth/reset` en *Redirect URLs*.
2. **Authentication → Email:** contraseña mínima 10 caracteres; SMTP corporativo.
3. **API → Exposed schemas:** solo `public`.
4. Aplicar el esquema (6 migraciones: esquemas, seguridad RLS, catálogos, métricas y bucket privado):
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
   Si el proyecto ya tiene migraciones de otras aplicaciones, aplicar los archivos de `supabase/migrations` en orden con el editor SQL o `psql`.

## 2. Variables de entorno

API (secretas, solo servidor):

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SECRET_KEY=<clave secreta o service_role>
DATABASE_URL=<cadena del pooler, modo sesión :5432>
AI_PROVIDER=openai
OPENAI_API_KEY=<llave>
OPENAI_MODEL=gpt-4.1-mini
APP_URL=https://<dominio-web>          # CORS; admite varios separados por coma
SEED_DEMO=true                         # cargar datos demo al arrancar (idempotente)
SEED_DEMO_RESOLVE_V2=false             # true = también resolver y publicar la V2
DEMO_PASSWORD=<contraseña de usuarios demo>
```

Web (públicas, en tiempo de compilación):

```
NUXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<clave publicable>
NUXT_PUBLIC_API_URL=https://<dominio-api>
```

## 3. Construir y ejecutar

```bash
docker compose up -d --build
```

O por separado, en la plataforma de contenedores corporativa:

```bash
docker build -f deploy/api.Dockerfile -t nexora-api .
docker build -f deploy/web.Dockerfile -t nexora-web \
  --build-arg NUXT_PUBLIC_SUPABASE_URL=... --build-arg NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... --build-arg NUXT_PUBLIC_API_URL=...
```

En redes con inspección TLS que bloquee `registry.npmjs.org`, agregar `--build-arg NPM_REGISTRY=https://registry.yarnpkg.com` (espejo oficial con los mismos paquetes).

## 4. Datos de demostración

Al arrancar con `SEED_DEMO=true`, la API ejecuta `scripts/deploy-seed.ts`, que es idempotente:

1. Datos maestros del Grupo Altavista (6 empresas, catálogos, homologación, tasas y parámetros).
2. Usuarios demo.
3. Presupuesto V1 y Proyección: carga real de los archivos de `data/demo`, consolidación, aprobación y publicación.
4. Presupuesto V2: cargado con 8 errores sembrados para la demostración (o resuelto y publicado con `SEED_DEMO_RESOLVE_V2=true`).

En arranques posteriores detecta lo existente y no duplica nada. Para un entorno con datos reales: `SEED_DEMO=false`.

## 5. Verificación posterior

- `GET https://<api>/api/health` → `{"status":"ok","ai_provider":"openai"}`.
- Ingresar con `director@altavista.example` y revisar el Overview.
- `npm run ai:check` con las variables de producción para confirmar la llave de OpenAI.

## Consideraciones

- OpenAI recibe preguntas, nombres de empresas y cifras agregadas de las consultas; nunca credenciales ni archivos. Revisar el acuerdo con el proveedor antes de usar datos reales.
- Los usuarios demo tienen una contraseña conocida: cambiarla (`DEMO_PASSWORD`) o eliminarlos en entornos compartidos.
