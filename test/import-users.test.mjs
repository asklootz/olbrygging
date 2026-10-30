import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { planUserImport } from '../scripts/import-users.mjs';

const password = 'BrewTogether!2026';
const salt = 'a'.repeat(32);
const user = {
  id: 'legacy-id', name: ' Test User ', email: ' EMPLOYEE@olbrygging.example ', role: 'employee',
  socialMedia: '@test', passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
};

test('import normalizes profiles and verifies demo passwords without forwarding legacy ids/hashes', () => {
  const plan = planUserImport({ users: [user] }, { demoPasswords: true });
  assert.deepEqual(plan, { skipped: 0, users: [{
    email: 'employee@olbrygging.example', name: 'Test User', role: 'employee', socialMedia: '@test', password,
  }] });
});

test('demo password reuse is explicit, hash-verified and limited to demo addresses', () => {
  assert.throws(() => planUserImport({ users: [user] }), /password/);
  for (const changes of [{ passwordHash: 'invalid' }, { email: 'real@example.com' }, {
    passwordHash: `${salt}:${scryptSync('Different password', salt, 64).toString('hex')}`,
  }]) {
    assert.throws(() => planUserImport({ users: [{ ...user, ...changes }] }, { demoPasswords: true }), /password/);
  }
});

test('new per-user passwords support non-demo accounts without preserving old hashes', () => {
  const real = { ...user, email: 'real@example.com' };
  const plan = planUserImport({ users: [real] }, { passwords: { 'real@example.com': 'New private password' } });
  assert.equal(plan.users[0].password, 'New private password');
  assert.equal(plan.users[0].passwordHash, undefined);
});

test('inactive users and local administrators are never activated or elevated during import', () => {
  const plan = planUserImport({ users: [{ ...user, active: false }, { ...user, role: 'admin' }] });
  assert.deepEqual(plan, { users: [], skipped: 2 });
});

test('invalid input and duplicate normalized email addresses fail preflight', () => {
  assert.throws(() => planUserImport({}), /users array/);
  assert.throws(() => planUserImport({ users: [null] }), /invalid user/);
  assert.throws(() => planUserImport({ users: [user] }, { passwords: [] }), /email-to-password/);
  for (const changes of [{ name: '' }, { role: 'superuser' }, { email: 'bad email' }, { socialMedia: 12 }]) {
    assert.throws(() => planUserImport({ users: [{ ...user, ...changes }] }, { demoPasswords: true }), /invalid user/);
  }
  assert.throws(() => planUserImport({ users: [user, { ...user, email: user.email.toLowerCase() }] }, { demoPasswords: true }), /duplicate/);
});

test('password constraints reject bcrypt truncation and short passwords', () => {
  for (const value of ['short', 'x'.repeat(73), 'ø'.repeat(37)]) {
    assert.throws(() => planUserImport({ users: [user] }, { passwords: { 'employee@olbrygging.example': value } }), /12–72/);
  }
});