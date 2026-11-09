import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const email = (process.env.PB_SUPERUSER_EMAIL ?? '').trim();
const password = process.env.PB_SUPERUSER_PASSWORD ?? '';

if (!email || !password) {
  console.log('PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD not set; skipping PocketBase superuser upsert.');
  process.exit(0);
}
if (password.length < 8) throw new Error('PB_SUPERUSER_PASSWORD must be at least 8 characters (PocketBase also requires mixed case and a number).');

const child = spawn(process.execPath, [
  require.resolve('@fadlee/pocketbase-bin/bin/runner.js'),
  '--pb-version', '0.40.6',
  'superuser', 'upsert', email, password,
  `--dir=${resolve(root, 'pb_data')}`,
  `--hooksDir=${resolve(root, 'pb_hooks')}`,
  `--migrationsDir=${resolve(root, 'pb_migrations')}`,
], { cwd: root, stdio: 'inherit' });

child.on('error', (error) => {
  console.error(`PocketBase could not start: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => {
  if (code === 0) return;
  console.error(`PocketBase superuser upsert exited (${code ?? 'signal'}).`);
  process.exit(code ?? 1);
});
