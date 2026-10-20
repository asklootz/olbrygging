import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../server.mjs';

const TEST_ROOT = resolve('.test-data');
mkdirSync(TEST_ROOT, { recursive: true });

async function fixture(t, options = {}) {
  const directory = mkdtempSync(resolve(TEST_ROOT, 'workspace-'));
  const dataFile = resolve(directory, 'workspace.json');
  const publicDir = resolve(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(resolve(publicDir, 'index.html'), '<!doctype html><title>Demo</title>');
  const app = createApp({ dataFile, publicDir, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise((done) => app.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    return { status: response.status, body: payload, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  async function login(email = 'ambassador@olbrygging.example') {
    const result = await call('/api/login', { method: 'POST', body: { email, password: 'BrewTogether!2026' } });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  return { app, base, call, login, dataFile, publicDir, directory };
}

test('authentication, safe workspace data, strict cookies and logout', async (t) => {
  const { call, login, dataFile } = await fixture(t);
  assert.deepEqual((await call('/api/session')).body, { user: null });
  assert.equal((await call('/api/workspace')).status, 401);
  const rejected = await call('/api/login', { method: 'POST', body: { email: 'ambassador@olbrygging.example', password: 'wrong' } });
  assert.equal(rejected.status, 401);
  const loggedIn = await call('/api/login', { method: 'POST', body: { email: 'ambassador@olbrygging.example', password: 'BrewTogether!2026' } });
  assert.match(loggedIn.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(loggedIn.cookie, /^olbrygging_session=[a-f0-9]{64}$/);
  const cookie = loggedIn.cookie;
  assert.equal((await call('/api/session', { cookie })).body.user.role, 'ambassador');
  const workspace = (await call('/api/workspace', { cookie })).body;
  assert.equal(workspace.products.length, 8);
  assert.equal(workspace.tickets.length, 4);
  assert.ok(workspace.tickets.every((ticket) => ticket.ambassadorId === 'emil'));
  assert.equal(workspace.users.some((user) => user.id === 'sara'), false);
  assert.equal(workspace.users.find((user) => user.id === 'marius')?.role, 'employee');
  assert.equal(JSON.stringify(workspace).includes('passwordHash'), false);
  assert.equal(JSON.stringify(workspace).includes('BrewTogether'), false);
  const stored = readFileSync(dataFile, 'utf8');
  assert.equal(stored.includes('BrewTogether'), false);
  assert.match(JSON.parse(stored).users[0].passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call('/api/workspace', { cookie: staff })).body.tickets.length, 5);
  assert.equal((await call('/api/logout', { method: 'POST', cookie })).status, 200);
  assert.deepEqual((await call('/api/session', { cookie })).body, { user: null });
});

test('ticket creation, employee approval and ambassador workflow persist across restart', async (t) => {
  const { call, login, dataFile, publicDir } = await fixture(t);
  const cookie = await login();
  const staff = await login('employee@olbrygging.example');
  const created = await call('/api/tickets', {
    method: 'POST', cookie,
    body: { productId: 'fjord-pale', subject: 'Mitt neste brygg', description: 'En ny bildeserie om bryggedagen.', channel: 'Instagram', dueDate: '2026-11-03' },
  });
  assert.equal(created.status, 201);
  const { ticket } = created.body;
  assert.equal(ticket.number, 1006);
  assert.equal(ticket.status, 'requested');
  assert.equal(ticket.assigneeId, 'nora');
  const path = `/api/tickets/${ticket.id}`;
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'approved' } })).status, 403);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'approved', assigneeId: 'emil' } })).status, 400);
  const approved = await call(path, { method: 'PATCH', cookie: staff, body: { status: 'approved', assigneeId: 'marius', dueDate: '2026-11-04' } });
  assert.equal(approved.body.ticket.status, 'approved');
  assert.equal(approved.body.ticket.assigneeId, 'marius');
  assert.equal(approved.body.ticket.dueDate, '2026-11-04');
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'in_progress' } })).status, 200);
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'review' } })).status, 200);
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'completed' } })).status, 403);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'completed' } })).status, 200);
  const second = createApp({ dataFile, publicDir });
  second.listen(0, '127.0.0.1');
  await once(second, 'listening');
  t.after(() => new Promise((done) => second.close(done)));
  const origin = `http://127.0.0.1:${second.address().port}`;
  const session = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ambassador@olbrygging.example', password: 'BrewTogether!2026' }),
  });
  await session.json();
  const result = await fetch(`${origin}/api/workspace`, { headers: { cookie: session.headers.get('set-cookie').split(';')[0] } });
  const persistedTicket = (await result.json()).tickets.find((item) => item.id === ticket.id);
  assert.equal(persistedTicket.status, 'completed');
  assert.equal(persistedTicket.assigneeId, 'marius');
});

test('cross-ambassador access, protected fields, and explicit staff creation', async (t) => {
  const { call, login } = await fixture(t);
  const cookie = await login();
  for (const [path, method, body] of [
    ['/api/tickets/ticket-1005', 'PATCH', { status: 'in_progress' }],
    ['/api/tickets/ticket-1005/messages', 'POST', { body: 'Ikke min forespørsel' }],
    ['/api/tickets/does-not-exist/messages', 'POST', { body: 'Hallo' }],
  ]) assert.equal((await call(path, { method, cookie, body })).status, 404);
  assert.equal((await call('/api/tickets/ticket-1002', { method: 'PATCH', cookie, body: { assigneeId: 'nora' } })).status, 403);
  const body = { productId: 'malt', subject: 'En maltguide', description: 'Dette er en ny guide.', channel: 'Blogg' };
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...body, ambassadorId: 'sara' } })).status, 403);
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call('/api/tickets', { method: 'POST', cookie: staff, body })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie: staff, body: { ...body, ambassadorId: 'nora' } })).status, 400);
  const created = await call('/api/tickets', { method: 'POST', cookie: staff, body: { ...body, ambassadorId: 'sara' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.ticket.ambassadorId, 'sara');
});

test('messages remain saved when email is unavailable or fails', async (t) => {
  let outgoing;
  const { call, login, dataFile } = await fixture(t, {
    emailApiKey: 'local-test-key', emailFrom: 'demo@example.test',
    fetchEmail: async (url, options) => {
      outgoing = { url, ...JSON.parse(options.body) };
      return new Response('provider failure with private details', { status: 503 });
    },
  });
  const cookie = await login();
  assert.equal((await call('/api/workspace', { cookie })).body.emailConfigured, true);
  const message = await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Her er en liten oppdatering!', sendEmail: true } });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.emailStatus, 'failed');
  assert.equal(message.body.message.authorId, 'emil');
  assert.deepEqual(outgoing.to, ['employee@olbrygging.example']);
  assert.equal(outgoing.url, 'https://api.resend.com/emails');
  assert.equal(JSON.stringify(message.body).includes('private'), false);
  const saved = JSON.parse(readFileSync(dataFile, 'utf8')).tickets.find((item) => item.id === 'ticket-1001').messages.at(-1);
  assert.equal(saved.id, message.body.message.id);
  assert.equal(saved.emailStatus, 'failed');
  const noMail = await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Bare i portalen.' } });
  assert.equal(noMail.body.message.emailStatus, 'not_requested');
  const other = await fixture(t, { emailApiKey: '', emailFrom: '' });
  const otherCookie = await other.login();
  const unavailable = await other.call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie: otherCookie, body: { body: 'Lagre likevel.', sendEmail: true } });
  assert.equal(unavailable.body.message.emailStatus, 'failed');
});

test('email success targets opposite participant, timeout preserves message', async (t) => {
  let recipient;
  const fixtureSent = await fixture(t, {
    emailApiKey: 'local-test-key', emailFrom: 'demo@example.test',
    fetchEmail: async (_url, options) => {
      recipient = JSON.parse(options.body).to;
      return new Response('{}', { status: 200 });
    },
  });
  const staff = await fixtureSent.login('employee@olbrygging.example');
  const sent = await fixtureSent.call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie: staff, body: { body: 'Takk for oppdateringen!', sendEmail: true } });
  assert.equal(sent.body.message.emailStatus, 'sent');
  assert.deepEqual(recipient, ['ambassador@olbrygging.example']);
  const fixtureTimeout = await fixture(t, {
    emailApiKey: 'local-test-key', emailFrom: 'demo@example.test', emailTimeoutMs: 10,
    fetchEmail: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
  });
  const cookie = await fixtureTimeout.login();
  const timedOut = await fixtureTimeout.call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Denne skal ikke forsvinne.', sendEmail: true } });
  assert.equal(timedOut.status, 201);
  assert.equal(timedOut.body.message.emailStatus, 'failed');
});

test('JSON, dates, lengths, enums, methods, body limits and same-origin validation', async (t) => {
  const { call, login } = await fixture(t);
  const cookie = await login();
  const base = { productId: 'malt', subject: 'Ny forespørsel', description: 'En liten beskrivelse.', channel: 'Instagram' };
  for (const change of [
    { subject: '' }, { subject: 'x'.repeat(161) }, { description: 'x'.repeat(5001) },
    { productId: 'missing' }, { channel: 'Facebook' }, { dueDate: '2026-02-30' },
    { dueDate: 'not-a-date' }, { dueDate: '2026-10-20T12:00:00Z' }, { status: 'approved' },
  ]) assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...base, ...change } })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, raw: '{' })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: [] })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { origin: '' } })).status, 403);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...base, description: 'x'.repeat(30000) } })).status, 413);
  assert.equal((await call('/api/unknown')).status, 404);
  assert.equal((await call('/api/session', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Hallo', sendEmail: 'yes' } })).status, 400);
  assert.equal((await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Hallo', to: 'arbitrary@example.test' } })).status, 400);
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call('/api/tickets/ticket-1001', { method: 'PATCH', cookie: staff, body: { status: 'invalid' } })).status, 400);
});

test('static files do not expose directories, workspace, symlinks or traversals', async (t) => {
  const { base, publicDir, dataFile } = await fixture(t);
  const root = await fetch(base);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(await root.text(), /Demo/);
  mkdirSync(resolve(publicDir, 'assets'));
  symlinkSync(dataFile, resolve(publicDir, 'secret.json'));
  for (const path of ['/assets', '/workspace.json', '/secret.json']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404);
    await response.text();
  }
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/%ZZ', '/..%2fworkspace.json', '/%5cworkspace.json', '//evil.example', '/%00']) {
    const response = await new Promise((done, reject) => {
      const req = request(base, { path }, (res) => {
        res.resume();
        res.on('end', () => done(res));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.statusCode, 400);
  }
});

test('concurrent creation preserves all writes with unique ticket numbers', async (t) => {
  const { call, login, dataFile } = await fixture(t);
  const cookie = await login();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => call('/api/tickets', {
    method: 'POST', cookie,
    body: { productId: 'malt', subject: `Forespørsel ${index}`, description: 'Test av samtidige forespørsler.', channel: 'Blogg' },
  })));
  assert.ok(responses.every((response) => response.status === 201));
  assert.equal(new Set(responses.map((response) => response.body.ticket.number)).size, 6);
  assert.equal(JSON.parse(readFileSync(dataFile, 'utf8')).tickets.length, 11);
});

test('profiles, articles, damage reports, and admin-only account management', async (t) => {
  const { call, login } = await fixture(t);
  const ambassador = await login();
  const employee = await login('employee@olbrygging.example');
  const admin = await login('admin@olbrygging.example');

  const workspace = (await call('/api/workspace', { cookie: ambassador })).body;
  assert.equal(workspace.articles.length, 2);
  assert.deepEqual(workspace.damageReports, []);
  assert.equal(workspace.users.some((item) => item.role === 'admin'), false);

  assert.equal((await call('/api/articles', { method: 'POST', cookie: ambassador, body: { title: 'Nei', body: 'Nei', category: 'Test' } })).status, 403);
  assert.equal((await call('/api/users', { cookie: employee })).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', cookie: employee, body: { name: 'Test', email: 'test@example.test', password: 'long-test-password', role: 'employee' } })).status, 403);

  const article = await call('/api/articles', { method: 'POST', cookie: employee, body: { title: 'Ny bryggeguide', body: 'Oppbevar råvarene kjølig.', category: 'Bryggetips' } });
  assert.equal(article.status, 201);
  assert.equal(article.body.article.authorId, 'nora');
  assert.equal(article.body.article.updatedBy, 'nora');
  const editedArticle = await call(`/api/articles/${article.body.article.id}`, { method: 'PATCH', cookie: employee, body: { title: 'Oppdatert bryggeguide' } });
  assert.equal(editedArticle.body.article.title, 'Oppdatert bryggeguide');
  assert.equal(editedArticle.body.article.authorId, 'nora');

  const report = await call('/api/damage-reports', { method: 'POST', cookie: ambassador, body: { productId: 'fjord-pale', description: 'Esken var skadet ved levering.' } });
  assert.equal(report.status, 201);
  assert.equal((await call(`/api/damage-reports/${report.body.report.id}`, { method: 'PATCH', cookie: ambassador, body: { status: 'approved' } })).status, 403);
  const approved = await call(`/api/damage-reports/${report.body.report.id}`, { method: 'PATCH', cookie: employee, body: { status: 'approved', reviewNote: 'Erstattes.' } });
  assert.equal(approved.body.report.status, 'approved');
  assert.equal((await call('/api/workspace', { cookie: ambassador })).body.damageReports[0].reviewNote, 'Erstattes.');

  const created = await call('/api/users', { method: 'POST', cookie: admin, body: { name: 'Ny ambassadør', email: 'new@example.test', password: 'temporary-password', role: 'ambassador' } });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes('passwordHash'), false);
  const disabled = await call(`/api/users/${created.body.user.id}`, { method: 'PATCH', cookie: admin, body: { active: false } });
  assert.equal(disabled.body.user.active, false);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'new@example.test', password: 'temporary-password' } })).status, 401);
  const profile = await call('/api/users/emil', { method: 'PATCH', cookie: employee, body: { socialMedia: '@emilbrygger' } });
  assert.equal(profile.body.user.socialMedia, '@emilbrygger');
});
