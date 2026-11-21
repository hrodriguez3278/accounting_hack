import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(10),
  DATABASE_URL: z.string().min(10),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  APP_URL: z.string().default('http://127.0.0.1:3000'),
  AI_PROVIDER: z.enum(['openai', 'ollama', 'local']).default('local'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.string().default('development'),
}).superRefine((e, ctx) => {
  if (e.AI_PROVIDER === 'openai' && !e.OPENAI_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'requerida cuando AI_PROVIDER=openai' });
  }
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Las plataformas de despliegue suelen asignar el puerto en PORT
  const parsed = Env.safeParse({ ...source, API_PORT: source.API_PORT ?? source.PORT });
  if (!parsed.success) {
    // Nunca se imprimen valores: solo los nombres de variables inválidas
    throw new Error(`Variables de entorno inválidas: ${parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ')}`);
  }
  return parsed.data;
}
