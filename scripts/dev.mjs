// Inicia la API (:4000) y la web (:3000) en paralelo. Ctrl+C detiene ambas.
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['run', 'dev', '-w', '@nexora/api']],
  ['web', ['run', 'dev', '-w', '@nexora/web']],
].map(([name, args]) => {
  const p = spawn('npm', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => process.stdout.write(d.toString().split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n');
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  p.on('exit', (code) => { console.log(`[${name}] terminó (${code})`); stop(); });
  return p;
});
function stop() { for (const p of procs) if (!p.killed) p.kill(); }
process.on('SIGINT', () => { stop(); process.exit(0); });
