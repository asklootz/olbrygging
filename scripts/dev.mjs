import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const backendUrl = 'http://127.0.0.1:8090';
if (process.env.POCKETBASE_URL && process.env.POCKETBASE_URL.replace(/\/$/, '') !== backendUrl) {
  throw new Error('npm run dev starts local PocketBase on port 8090. Use npm start for an external POCKETBASE_URL.');
}
process.env.POCKETBASE_URL = backendUrl;

const backend = spawn(process.execPath, [
  require.resolve('@fadlee/pocketbase-bin/bin/runner.js'),
  '--pb-version', '0.40.6', 'serve', '--http=127.0.0.1:8090',
  `--dir=${resolve(root, 'pb_data')}`,
  `--hooksDir=${resolve(root, 'pb_hooks')}`,
  `--migrationsDir=${resolve(root, 'pb_migrations')}`,
  '--hooksWatch=false',
], { cwd: root, stdio: 'inherit' });

let server;
let stopping = false;
let exitTimer;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  server?.close();
  backend.kill('SIGTERM');
  // The npm binary wrapper forwards signals to its native child.
  exitTimer = setTimeout(() => {
    server?.closeAllConnections();
    backend.kill('SIGKILL');
  }, 5000);
  exitTimer.unref();
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
backend.once('error', (error) => {
  console.error(`PocketBase could not start: ${error.message}`);
  stop(1);
});
backend.once('exit', (code) => {
  if (!stopping) {
    console.error(`PocketBase exited (${code ?? 'signal'}).`);
    stop(1);
  }
  clearTimeout(exitTimer);
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    try {
      const response = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Wait for the native binary download and database migrations.
    }
    await delay(500);
  }
  if (!ready && !stopping) throw new Error('PocketBase did not become ready within 60 seconds. Check its output above.');
  if (!stopping) {
    const port = Number(process.env.PORT ?? 3000);
    const host = process.env.HOST ?? '127.0.0.1';
    server = createApp();
    server.once('error', (error) => {
      console.error(`Portal could not start: ${error.message}`);
      stop(1);
    });
    server.listen(port, host, () => console.log(`Ølbrygging: http://${host}:${port}`));
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
