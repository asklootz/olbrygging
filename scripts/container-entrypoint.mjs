import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

// Container supervisor: starts the pinned PocketBase binary on loopback:8090
// (data on the mounted volume), waits for backend readiness, then starts the
// portal for all interfaces. The container only exposes the portal port.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.POCKETBASE_BINARY || resolve(root, 'pocketbase');
const dataDir = resolve(process.env.PB_DATA_DIR || 'pb_data');
const backendUrl = 'http://127.0.0.1:8090';
// The portal always talks to the local PocketBase inside this container.
process.env.POCKETBASE_URL = backendUrl;

console.log(`Starting PocketBase ${backendUrl} (data: ${dataDir})`);
const backend = spawn(binary, [
  'serve', '--http=127.0.0.1:8090',
  `--dir=${dataDir}`,
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
  // PocketBase closes its SQLite database on SIGTERM; give it a moment.
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
  // First boot runs migrations on a network volume; allow up to 120 seconds.
  for (let attempt = 0; attempt < 240 && !stopping; attempt++) {
    try {
      const response = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Wait for migrations and database initialization.
    }
    await delay(500);
  }
  if (!ready && !stopping) throw new Error('PocketBase did not become ready within 120 seconds. Check its output above.');
  if (!stopping) {
    const port = Number(process.env.PORT ?? 3000);
    const host = process.env.HOST || '0.0.0.0';
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