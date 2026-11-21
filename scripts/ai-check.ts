/**
 * Verifica la conexión con el proveedor de IA configurado (OPENAI_API_KEY / OPENAI_MODEL).
 * Envía una solicitud mínima sin datos financieros. Uso: npm run ai:check
 */
import OpenAI from 'openai';

const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
if (process.env.AI_PROVIDER !== 'openai') console.warn(`Aviso: AI_PROVIDER=${process.env.AI_PROVIDER ?? '(vacío)'}; la API usará el proveedor local.`);
if (!key) { console.error('Falta OPENAI_API_KEY en .env'); process.exit(1); }
const client = new OpenAI({ apiKey: key, timeout: 30_000, maxRetries: 0 });
try {
  const r = await client.chat.completions.create({ model, temperature: 0, max_tokens: 5,
    messages: [{ role: 'user', content: 'Responde únicamente: OK' }] });
  console.log(`Conexión correcta. Modelo: ${r.model}. Respuesta: ${r.choices[0]?.message.content ?? ''}`);
} catch (e) {
  const status = (e as { status?: number }).status;
  console.error(`Falló la conexión (${status ?? 'red'}): ${status === 401 ? 'llave rechazada' : status === 404 ? `modelo '${model}' no disponible` : status === 429 ? 'límite o saldo agotado' : 'revise red/proxy'}`);
  process.exit(1);
}
