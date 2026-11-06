import { scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const demoPassword = 'BrewTogether!2026';

function matchesDemoPassword(hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
  const [salt, hex] = hash.split(':');
  return timingSafeEqual(scryptSync(demoPassword, salt, 64), Buffer.from(hex, 'hex'));
}

// Old scrypt hashes cannot be installed as PocketBase bcrypt passwords.
// A password file assigns new passwords; demo reuse requires a verified hash.
export function planUserImport(workspace, { demoPasswords = false, passwords = {} } = {}) {
  if (!workspace || !Array.isArray(workspace.users)) throw new Error('Source must contain a users array.');
  if (!passwords || typeof passwords !== 'object' || Array.isArray(passwords)) throw new Error('Password file must be an email-to-password object.');
  const users = [];
  const seen = new Set();
  let skipped = 0;
  for (const user of workspace.users) {
    if (user?.role === 'admin' || user?.active === false) { skipped++; continue; }
    const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || typeof user.name !== 'string' || !user.name.trim() || user.name.trim().length > 160
      || !['employee', 'ambassador'].includes(user.role)
      || (user.socialMedia !== undefined && (typeof user.socialMedia !== 'string' || user.socialMedia.length > 200))) {
      throw new Error('Source contains an invalid user profile. No users imported.');
    }
    if (seen.has(email)) throw new Error('Source contains duplicate email addresses. No users imported.');
    seen.add(email);
    let password = Object.hasOwn(passwords, email) ? passwords[email] : undefined;
    if (password === undefined && demoPasswords && email.endsWith('@olbrygging.example') && matchesDemoPassword(user.passwordHash)) {
      password = demoPassword;
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 72
      || Buffer.byteLength(password) > 72) {
      throw new Error('Each active user needs a 12–72 byte password in --passwords-file, or a verified demo password with --demo-passwords.');
    }
    users.push({ email, name: user.name.trim(), role: user.role, socialMedia: user.socialMedia || '', password });
  }
  return { users, skipped };
}

function main() {
  const args = process.argv.slice(2);
  let source = process.env.DATA_FILE || resolve(root, 'data/workspace.json');
  let directory = resolve(root, 'pb_data');
  let passwords = {};
  let apply = false;
  let demoPasswords = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--demo-passwords') demoPasswords = true;
    else if (['--source', '--dir', '--passwords-file'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = resolve(args[++i]);
      if (arg === '--source') source = value;
      else if (arg === '--dir') directory = value;
      else passwords = JSON.parse(readFileSync(value, 'utf8'));
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  const plan = planUserImport(JSON.parse(readFileSync(resolve(source), 'utf8')), { demoPasswords, passwords });
  console.log(`${plan.users.length} active portal users eligible; ${plan.skipped} inactive/admin users skipped.`);
  if (!apply) {
    console.log('Dry run only. Stop PocketBase, back up pb_data, then repeat with --apply. Existing accounts will not be changed.');
    return;
  }
  const result = spawnSync(process.execPath, [
    require.resolve('@fadlee/pocketbase-bin/bin/runner.js'), '--pb-version', '0.40.6',
    'portal-import-users', `--dir=${directory}`, `--hooksDir=${resolve(root, 'pb_hooks')}`,
    `--migrationsDir=${resolve(root, 'pb_migrations')}`,
  ], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, OLBRYGGING_IMPORT_USERS: JSON.stringify(plan.users) },
  });
  if (result.error || result.status !== 0) throw new Error('PocketBase user import failed. Check the output above.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    // Never print source JSON, password-file contents, or child environment.
    console.error(error instanceof SyntaxError ? 'Invalid JSON in import input.' : error.message);
    process.exitCode = 1;
  }
}