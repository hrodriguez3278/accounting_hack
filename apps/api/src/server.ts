import { loadEnv } from './env.js';
import { buildApp, createDeps } from './app.js';

const env = loadEnv();
const deps = createDeps(env);
const app = await buildApp(deps);

const close = async () => {
  await app.close();
  await deps.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ host: env.API_HOST, port: env.API_PORT });
